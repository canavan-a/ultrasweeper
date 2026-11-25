// flagsrv serves the flag-annotation protocol (FLAGS.md) and stores
// uploaded hunt files. SQLite via modernc.org/sqlite (no CGO), schema
// via goose migrations.
//
//	flagsrv -db flags.db -uploads ./uploads -upload-key <password>
//
// GET    /flags        → the flag JSON the phone pulls (see FLAGS.md)
// POST   /flags        → add a record (id optional; f-… generated)
// GET    /flags/{id}   → one record
// PUT    /flags/{id}   → replace flag/note/matchers
// DELETE /flags/{id}   → remove a record
// GET    /uploads      → list stored hunt files
// POST   /upload       → store one hunt file (X-Upload-Key)
// GET    /healthz      → "ok"
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

const maxUploadBytes = 64 << 20 // hunt CSVs are a few MB; keep the headroom sane

type server struct {
	db         *sql.DB
	uploadsDir string
	uploadKey  string // empty = uploads disabled
}

func main() {
	var (
		addr      = flag.String("addr", "127.0.0.1:8788", "listen address")
		dbPath    = flag.String("db", "flags.db", "sqlite database path")
		uploads   = flag.String("uploads", "uploads", "directory for uploaded hunt files")
		uploadKey = flag.String("upload-key", os.Getenv("FLAGSRV_UPLOAD_KEY"), "X-Upload-Key value for POST /upload (empty disables uploads)")
		seed      = flag.String("seed", "", "optional JSON file of flag records to upsert at startup")
	)
	flag.Parse()

	db, err := openDB(*dbPath)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	if *seed != "" {
		if err := seedFlags(db, *seed); err != nil {
			log.Fatalf("seed: %v", err)
		}
	}
	if err := os.MkdirAll(*uploads, 0o755); err != nil {
		log.Fatalf("uploads dir: %v", err)
	}

	s := &server{db: db, uploadsDir: *uploads, uploadKey: *uploadKey}

	log.Printf("flagsrv on %s (db=%s uploads=%s uploads_keyed=%v)", *addr, *dbPath, *uploads, *uploadKey != "")
	if err := http.ListenAndServe(*addr, s.routes()); err != nil {
		log.Fatal(err)
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /flags", s.handleListFlags)
	mux.HandleFunc("POST /flags", s.handleCreateFlag)
	mux.HandleFunc("GET /flags/{id}", s.handleGetFlag)
	mux.HandleFunc("PUT /flags/{id}", s.handlePutFlag)
	mux.HandleFunc("DELETE /flags/{id}", s.handleDeleteFlag)
	mux.HandleFunc("GET /uploads", s.handleListUploads)
	mux.HandleFunc("POST /upload", s.handleUpload)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "ok")
	})
	return mux
}

// ---- GET /flags -------------------------------------------------------------

type matcherJSON struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

type flagJSON struct {
	ID        string        `json:"id"`
	Flag      bool          `json:"flag"`
	Note      string        `json:"note"`
	Matchers  []matcherJSON `json:"matchers"`
	UpdatedAt string        `json:"updated_at"`
}

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+"?_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single-writer sqlite; avoids SQLITE_BUSY under concurrent pulls

	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("sqlite3"); err != nil {
		return nil, err
	}
	if err := goose.UpContext(context.Background(), db, "migrations"); err != nil {
		return nil, err
	}
	return db, nil
}

// ---- flag records -----------------------------------------------------------

var matcherKinds = map[string]bool{
	"mac": true, "name": true, "company": true,
	"service": true, "eddy_uid": true, "oui": true,
}

// validateRecord enforces the FLAGS.md shape before anything reaches the db
// (the schema CHECK is the backstop, not the gate).
func validateRecord(f *flagJSON, requireID bool) error {
	if requireID && !validIDChars(f.ID) {
		return fmt.Errorf("id must match [A-Za-z0-9._-]{1,64}")
	}
	if !requireID && f.ID != "" && !validIDChars(f.ID) {
		return fmt.Errorf("id must match [A-Za-z0-9._-]{1,64}")
	}
	if len(f.Note) > 1000 {
		return fmt.Errorf("note exceeds 1000 chars")
	}
	if len(f.Matchers) == 0 || len(f.Matchers) > 16 {
		return fmt.Errorf("a record needs 1..16 matchers")
	}
	for _, m := range f.Matchers {
		if !matcherKinds[m.Kind] {
			return fmt.Errorf("bad matcher kind %q", m.Kind)
		}
		if m.Value == "" || len(m.Value) > 64 {
			return fmt.Errorf("bad matcher value for kind %q", m.Kind)
		}
	}
	return nil
}

func validIDChars(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// genID matches the "f-…" convention in FLAGS.md when the client omits an id.
func genID() string {
	var b [4]byte
	rand.Read(b[:])
	return fmt.Sprintf("f-%s-%x", time.Now().UTC().Format("20060102T150405Z"), b)
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// writeRecord upserts one record + rewrites its matchers; every write bumps
// the revision the client displays next to "last pull".
func writeRecord(x execer, f *flagJSON) error {
	on := 0
	if f.Flag {
		on = 1
	}
	if _, err := x.Exec(
		`INSERT INTO flags (id, flag, note, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET flag=excluded.flag, note=excluded.note, updated_at=excluded.updated_at`,
		f.ID, on, f.Note, f.UpdatedAt); err != nil {
		return err
	}
	if _, err := x.Exec(`DELETE FROM flag_matchers WHERE flag_id=?`, f.ID); err != nil {
		return err
	}
	for _, m := range f.Matchers {
		if _, err := x.Exec(`INSERT INTO flag_matchers (flag_id, kind, value) VALUES (?, ?, ?)`, f.ID, m.Kind, m.Value); err != nil {
			return err
		}
	}
	_, err := x.Exec(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'`)
	return err
}

// listFlags returns one record (id set) or all of them (id == "").
func (s *server) listFlags(id string) ([]flagJSON, error) {
	q := `SELECT id, flag, note, updated_at FROM flags`
	args := []any{}
	if id != "" {
		q += ` WHERE id=?`
		args = append(args, id)
	}
	q += ` ORDER BY updated_at DESC, id`

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	flags := []*flagJSON{}
	for rows.Next() {
		var f flagJSON
		var on int
		if err := rows.Scan(&f.ID, &on, &f.Note, &f.UpdatedAt); err != nil {
			return nil, err
		}
		f.Flag = on != 0
		f.Matchers = []matcherJSON{}
		flags = append(flags, &f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	byID := map[string]*flagJSON{}
	for _, f := range flags {
		byID[f.ID] = f
	}
	mq := `SELECT flag_id, kind, value FROM flag_matchers`
	var margs []any
	if id != "" {
		mq += ` WHERE flag_id=?`
		margs = append(margs, id)
	}
	mrows, err := s.db.Query(mq, margs...)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var fid string
		var m matcherJSON
		if err := mrows.Scan(&fid, &m.Kind, &m.Value); err != nil {
			return nil, err
		}
		if f := byID[fid]; f != nil {
			f.Matchers = append(f.Matchers, m)
		}
	}
	if err := mrows.Err(); err != nil {
		return nil, err
	}

	out := make([]flagJSON, 0, len(flags))
	for _, f := range flags {
		out = append(out, *f)
	}
	return out, nil
}

func (s *server) revision() (int64, error) {
	var raw string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key='revision'`).Scan(&raw); err != nil {
		return 0, err
	}
	return flagsRevision(raw), nil
}

func flagsRevision(raw string) int64 {
	var n int64
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int64(r-'0')
	}
	return n
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// ---- flags management API (FLAGS.md). LAN-side management: no auth in
// v0, same rule as GET /flags — the URL itself is the access control. -----

// GET /flags — the pull endpoint the phone uses.
func (s *server) handleListFlags(w http.ResponseWriter, _ *http.Request) {
	flags, err := s.listFlags("")
	if err != nil {
		http.Error(w, "flags: "+err.Error(), http.StatusInternalServerError)
		return
	}
	rev, err := s.revision()
	if err != nil {
		http.Error(w, "revision: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": rev, "flags": flags})
}

// GET /flags/{id}
func (s *server) handleGetFlag(w http.ResponseWriter, r *http.Request) {
	flags, err := s.listFlags(r.PathValue("id"))
	if err != nil {
		http.Error(w, "flags: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if len(flags) == 0 {
		http.Error(w, "no such flag", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, flags[0])
}

// POST /flags — add a record; id is optional (server generates "f-…").
func (s *server) handleCreateFlag(w http.ResponseWriter, r *http.Request) {
	var f flagJSON
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&f); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateRecord(&f, false); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if f.ID == "" {
		f.ID = genID()
	}
	if f.UpdatedAt == "" {
		f.UpdatedAt = nowUTC()
	}
	existing, err := s.listFlags(f.ID)
	if err != nil {
		http.Error(w, "flags: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if len(existing) > 0 {
		http.Error(w, "id already exists", http.StatusConflict)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		http.Error(w, "begin: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	if err := writeRecord(tx, &f); err != nil {
		http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, "commit: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

// PUT /flags/{id} — replace flag/note/matchers wholesale.
func (s *server) handlePutFlag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var f flagJSON
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&f); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	f.ID = id
	if err := validateRecord(&f, true); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	existing, err := s.listFlags(id)
	if err != nil {
		http.Error(w, "flags: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if len(existing) == 0 {
		http.Error(w, "no such flag", http.StatusNotFound)
		return
	}
	if f.UpdatedAt == "" {
		f.UpdatedAt = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		http.Error(w, "begin: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	if err := writeRecord(tx, &f); err != nil {
		http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, "commit: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// DELETE /flags/{id}
func (s *server) handleDeleteFlag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	res, err := s.db.Exec(`DELETE FROM flags WHERE id=?`, id)
	if err != nil {
		http.Error(w, "delete: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "no such flag", http.StatusNotFound)
		return
	}
	if _, err := s.db.Exec(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'`); err != nil {
		http.Error(w, "revision: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": id})
}

// ---- GET /uploads ------------------------------------------------------------

type uploadJSON struct {
	Name    string `json:"name"`
	Bytes   int64  `json:"bytes"`
	ModTime string `json:"mtime"`
}

// GET /uploads — what's sitting in the uploads dir, newest first.
func (s *server) handleListUploads(w http.ResponseWriter, _ *http.Request) {
	entries, err := os.ReadDir(s.uploadsDir)
	if err != nil {
		http.Error(w, "readdir: "+err.Error(), http.StatusInternalServerError)
		return
	}
	out := []uploadJSON{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, uploadJSON{Name: e.Name(), Bytes: info.Size(), ModTime: info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	writeJSON(w, http.StatusOK, map[string]any{"uploads": out})
}

// ---- POST /upload -----------------------------------------------------------

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if s.uploadKey == "" {
		http.Error(w, "uploads disabled (no -upload-key)", http.StatusForbidden)
		return
	}
	if r.Header.Get("X-Upload-Key") != s.uploadKey {
		http.Error(w, "bad X-Upload-Key", http.StatusUnauthorized)
		return
	}

	name := filepath.Base(r.Header.Get("X-File-Name"))
	name = strings.Map(func(c rune) rune {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_' {
			return c
		}
		return '_'
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "upload"
	}

	// keep "for later inspection" unambiguous: never overwrite, prefix a stamp
	stamped := time.Now().UTC().Format("20060102-150405-") + name

	f, err := os.OpenFile(filepath.Join(s.uploadsDir, stamped), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		http.Error(w, "create: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()

	n, err := io.Copy(f, http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if err != nil {
		os.Remove(filepath.Join(s.uploadsDir, stamped))
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": stamped, "bytes": n})
}

// ---- seed -------------------------------------------------------------------

// seedFlags upserts flag records from a JSON file shaped like the GET /flags
// response ("flags" array only). Idempotent: re-running replaces the record
// for the same id and rewrites its matchers.
func seedFlags(db *sql.DB, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc struct {
		Flags []flagJSON `json:"flags"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, f := range doc.Flags {
		if err := validateRecord(&f, true); err != nil {
			return err
		}
		if f.UpdatedAt == "" {
			f.UpdatedAt = nowUTC()
		}
		if err := writeRecord(tx, &f); err != nil {
			return err
		}
	}
	log.Printf("seeded %d flag records", len(doc.Flags))
	return tx.Commit()
}
