package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPilotWebConsoleIsSameOriginAndLocal(t *testing.T) {
	p := createPilot(t)
	for _, test := range []struct{ path, contentType, needle string }{
		{"/", "text/html", "ND Cloud — Local Pilot"},
		{"/assets/app.js", "text/javascript", "localStorage"},
		{"/assets/styles.css", "text/css", ".sidebar"},
	} {
		r := httptest.NewRequest("GET", test.path, nil)
		w := httptest.NewRecorder()
		p.handler.ServeHTTP(w, r)
		expectStatus(t, w, 200)
		if !strings.Contains(w.Header().Get("Content-Type"), test.contentType) {
			t.Fatalf("wrong content type: %s", test.path)
		}
		if !strings.Contains(w.Body.String(), test.needle) {
			t.Fatalf("missing asset data: %s", test.path)
		}
		csp := w.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "connect-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Fatalf("weak CSP: %s", csp)
		}
	}
	r := httptest.NewRequest("GET", "/assets/../../store.go", nil)
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	if w.Code == 200 {
		t.Fatal("filesystem traversal served")
	}
}
