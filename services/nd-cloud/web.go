package main

import (
	"embed"
	"net/http"
)

//go:embed web/index.html web/app.js web/styles.css
var webAssets embed.FS

// The pilot console is self-contained and same-origin. No token is persisted in
// browser storage, and no third-party script or remote API is permitted by CSP.
func staticWebFile(asset, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := webAssets.ReadFile(asset)
		if err != nil {
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
	}
}
