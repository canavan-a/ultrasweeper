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
