// End-to-end checks against the real handlers + a real sqlite file:
// the CRUD semantics FLAGS.md promises (revision bumps, 409/404/400
// behavior) and the upload key gate.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	s := &server{db: db, uploadsDir: filepath.Join(dir, "uploads"), uploadKey: "penguin"}
	if err := os.MkdirAll(s.uploadsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.routes())
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, method, url, body string) (*http.Response, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	all, _ := io.ReadAll(res.Body)
	return res, string(all)
}

const twoMatchers = `{"flag":true,"note":"entry point","matchers":[{"kind":"name","value":"Jarvis"},{"kind":"service","value":"FE2C"}]}`

func TestFlagCRUD(t *testing.T) {
	ts := newTestServer(t)

	res, body := do(t, "POST", ts.URL+"/flags", twoMatchers)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, body)
	}
	var created flagJSON
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.ID, "f-") || len(created.Matchers) != 2 {
		t.Fatalf("bad created record: %s", body)
	}

	// duplicate client-supplied id → 409
	res, _ = do(t, "POST", ts.URL+"/flags", `{"id":"`+created.ID+`","flag":true,"matchers":[{"kind":"mac","value":"AA:BB:CC:DD:EE:01"}]}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("dup create: want 409, got %d", res.StatusCode)
	}

	// bad matcher kind → 400
	res, _ = do(t, "POST", ts.URL+"/flags", `{"flag":true,"matchers":[{"kind":"vuln","value":"x"}]}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad kind: want 400, got %d", res.StatusCode)
	}

	// pull sees it, with matchers, revision bumped from the seed 1
	res, body = do(t, "GET", ts.URL+"/flags", "")
	var list struct {
		Revision int64      `json:"revision"`
		Flags    []flagJSON `json:"flags"`
	}
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Flags) != 1 || len(list.Flags[0].Matchers) != 2 {
		t.Fatalf("pull: %s", body)
	}
	if list.Revision < 2 {
		t.Fatalf("revision not bumped: %d", list.Revision)
	}

	// replace via PUT
	res, body = do(t, "PUT", ts.URL+"/flags/"+created.ID, `{"flag":false,"note":"checked, clear","matchers":[{"kind":"name","value":"Jarvis"}]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %s", res.StatusCode, body)
	}

	res, body = do(t, "GET", ts.URL+"/flags/"+created.ID, "")
	var got flagJSON
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Flag || got.Note != "checked, clear" || len(got.Matchers) != 1 {
		t.Fatalf("put not applied: %s", body)
	}

	// delete, then 404 on repeat
	res, _ = do(t, "DELETE", ts.URL+"/flags/"+created.ID, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	res, _ = do(t, "DELETE", ts.URL+"/flags/"+created.ID, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("re-delete: want 404, got %d", res.StatusCode)
	}
	res, _ = do(t, "GET", ts.URL+"/flags/"+created.ID, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("get deleted: want 404, got %d", res.StatusCode)
	}
}

func TestSeedAndUpload(t *testing.T) {
	ts := newTestServer(t)

	// upload: missing key → 401
	res, _ := do(t, "POST", ts.URL+"/upload", "time,mac\n1,AA:BB")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unkeyed upload: want 401, got %d", res.StatusCode)
	}

	// correct key stores the file and it appears in GET /uploads
	req, _ := http.NewRequest("POST", ts.URL+"/upload", bytes.NewReader([]byte("time,mac\n1,AA:BB")))
	req.Header.Set("X-Upload-Key", "penguin")
	req.Header.Set("X-File-Name", "hunt demo.csv")
	res, body := mustDo(t, req)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d %s", res.StatusCode, body)
	}
	var up struct {
		OK   bool   `json:"ok"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(body), &up); err != nil || !up.OK {
		t.Fatalf("upload resp: %s", body)
	}
	if !strings.HasPrefix(up.Path, "hunt_demo.csv") && !strings.Contains(up.Path, "hunt_demo.csv") {
		t.Fatalf("sanitized name missing: %s", up.Path)
	}

	res, body = do(t, "GET", ts.URL+"/uploads", "")
	if res.StatusCode != http.StatusOK || !strings.Contains(body, "hunt_demo.csv") {
		t.Fatalf("uploads list: %d %s", res.StatusCode, body)
	}
}

func mustDo(t *testing.T, req *http.Request) (*http.Response, string) {
	t.Helper()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	all, _ := io.ReadAll(res.Body)
	return res, string(all)
}

// Per-kind matcher formats: values the client can never match are refused,
// and the shipped seed file must pass the same gate.
func TestMatcherValueFormats(t *testing.T) {
	ts := newTestServer(t)
	post := func(kind, value string) int {
		t.Helper()
		body := `{"flag":true,"matchers":[{"kind":"` + kind + `","value":"` + value + `"}]}`
		res, _ := do(t, "POST", ts.URL+"/flags", body)
		return res.StatusCode
	}
	good := [][2]string{
		{"mac", "AA:BB:CC:DD:EE:01"}, {"mac", "aa:bb:cc:dd:ee:01"},
		{"oui", "54:92:6A"}, {"oui", "54926A"},
		{"company", "004C"}, {"company", "0x4c"},
		{"service", "FE2C"}, {"service", "0000FE2C-0000-1000-8000-00805F9B34FB"},
		{"eddy_uid", "534D4152542D4C4F434B"}, {"eddy_uid", "534D415254"},
		{"name", "Govee_H6099_5194"},
	}
	for _, g := range good {
		if code := post(g[0], g[1]); code != http.StatusCreated {
			t.Errorf("%s %q: want 201, got %d", g[0], g[1], code)
		}
	}
	bad := [][2]string{
		{"mac", "AA:BB:CC:DD:EE"}, {"mac", "AABBCCDDEE01"},
		{"oui", "54:92"}, {"company", "12345"}, {"company", "zz"},
		{"service", "FE2"}, {"service", "FE2CFE"},
		{"eddy_uid", "534D4152542D4C4F43"}, // 18 hex: the old docs example
		{"eddy_uid", "XYZ"},
	}
	for _, b := range bad {
		if code := post(b[0], b[1]); code != http.StatusBadRequest {
			t.Errorf("%s %q: want 400, got %d", b[0], b[1], code)
		}
	}

	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "seed.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := seedFlags(db, "seed.example.json"); err != nil {
		t.Fatalf("seed.example.json must validate: %v", err)
	}
}

// "local-…" ids belong to the phone; a server record with one would be
// shown as an on-phone record, so every write path refuses it.
func TestLocalIDPrefixReserved(t *testing.T) {
	ts := newTestServer(t)
	res, _ := do(t, "POST", ts.URL+"/flags", `{"id":"local-AABBCCDDEE01","flag":true,"matchers":[{"kind":"name","value":"x"}]}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST local- id: want 400, got %d", res.StatusCode)
	}
	res, _ = do(t, "PUT", ts.URL+"/flags/LOCAL-x", `{"flag":true,"matchers":[{"kind":"name","value":"x"}]}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("PUT local- id: want 400, got %d", res.StatusCode)
	}
}

// X-File-Name is percent-encoded (the app sends encodeURIComponent):
// decoded before sanitizing, and an encoded "../" can't escape the dir.
func TestUploadFileNameDecoded(t *testing.T) {
	ts := newTestServer(t)
	for _, c := range []struct{ header, want string }{
		{"hunt%2D1.csv", "hunt-1.csv"},
		{"hunt_2026-11-24_09-47-58.csv", "hunt_2026-11-24_09-47-58.csv"},
		{"..%2F..%2Fetc%2Fpasswd", "passwd"},
		{"bad%zzname.csv", "bad_zzname.csv"}, // not valid escaping: used as sent
	} {
		req, _ := http.NewRequest("POST", ts.URL+"/upload", strings.NewReader("x"))
		req.Header.Set("X-Upload-Key", "penguin")
		req.Header.Set("X-File-Name", c.header)
		res, body := mustDo(t, req)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%q: %d %s", c.header, res.StatusCode, body)
		}
		var up struct {
			Path string `json:"path"`
		}
		json.Unmarshal([]byte(body), &up)
		if len(up.Path) < 16 || up.Path[16:] != c.want {
			t.Errorf("%q: stored as %q, want suffix %q", c.header, up.Path, c.want)
		}
	}
}

// -base-path mounts everything under a secret prefix; the root 404s, and
// the app's <prefix>/flags → <prefix>/upload derivation lands on a route.
func TestBasePath(t *testing.T) {
	if _, err := normBasePath("/a/../b"); err == nil {
		t.Fatal("normBasePath accepted ..")
	}
	prefix, err := normBasePath("/k3x9q/")
	if err != nil || prefix != "/k3x9q" {
		t.Fatalf("normBasePath: %q %v", prefix, err)
	}
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	s := &server{db: db, uploadsDir: dir, uploadKey: "penguin"}
	ts := httptest.NewServer(withBasePath(prefix, s.routes()))
	t.Cleanup(ts.Close)

	if res, _ := do(t, "GET", ts.URL+"/flags", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("root /flags: want 404, got %d", res.StatusCode)
	}
	if res, body := do(t, "GET", ts.URL+"/k3x9q/flags", ""); res.StatusCode != http.StatusOK || !strings.Contains(body, `"flags"`) {
		t.Fatalf("prefixed /flags: %d %s", res.StatusCode, body)
	}
	req, _ := http.NewRequest("POST", ts.URL+"/k3x9q/upload", strings.NewReader("x"))
	req.Header.Set("X-Upload-Key", "penguin")
	req.Header.Set("X-File-Name", "hunt.csv")
	if res, body := mustDo(t, req); res.StatusCode != http.StatusOK {
		t.Fatalf("prefixed /upload: %d %s", res.StatusCode, body)
	}
}
