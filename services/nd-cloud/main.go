// ND Cloud loopback pilot. NOT an Internet-facing SaaS server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Printf("nd-cloud: %v", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: nd-cloud serve|bootstrap|grant|bind-host|revoke [flags]")
	}
	cmd := args[0]
	f := flag.NewFlagSet(cmd, flag.ContinueOnError)
	f.SetOutput(os.Stderr)
	data := f.String("data", filepath.Join(".local", "nd-cloud.json"), "private state file")
	tenant := f.String("tenant", "", "tenant ID")
	name := f.String("name", "", "human-readable name")
	subject := f.String("subject", "", "authenticated principal ID")
	role := f.String("role", "viewer", "viewer or reviewer")
	projects := f.String("projects", "", "comma-separated allowed project IDs")
	project := f.String("project", "", "cloud project ID")
	company := f.String("local-company", "", "ND local company ID")
	localProject := f.String("local-project", "", "ND local project ID")
	tokenID := f.String("token-id", "", "issued credential ID to revoke")
	addr := f.String("addr", "127.0.0.1:8787", "loopback listener (no public bind)")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if len(f.Args()) != 0 {
		return errors.New("unexpected positional arguments")
	}
	s, err := openStore(*data)
	if err != nil {
		return err
	}
	switch cmd {
	case "bootstrap":
		if *tenant == "" || *subject == "" || *name == "" {
			return errors.New("bootstrap requires -tenant -name -subject")
		}
		key, err := s.bootstrap(*tenant, *name, *subject)
		if err != nil {
			return err
		}
		fmt.Printf("Bootstrap owner token (shown once): %s\n", key)
		return nil
	case "grant":
		if *tenant == "" || *subject == "" || *projects == "" {
			return errors.New("grant requires -tenant -subject -projects")
		}
		key, err := s.issueHuman(*tenant, *subject, *role, strings.Split(*projects, ","))
		if err != nil {
			return err
		}
		fmt.Printf("Human token (shown once): %s\n", key)
		return nil
	case "bind-host":
		if *tenant == "" || *project == "" || *company == "" || *localProject == "" {
			return errors.New("bind-host requires -tenant -project -local-company -local-project")
		}
		key, err := s.issueHost(*tenant, *project, *company, *localProject)
		if err != nil {
			return err
		}
		fmt.Printf("Read-only projection upload credential (shown once): %s\n", key)
		return nil
	case "revoke":
		if *tokenID == "" {
			return errors.New("revoke requires -token-id")
		}
		if err := s.revokeToken(*tokenID); err != nil {
			return err
		}
		fmt.Println("Credential revoked")
		return nil
	case "serve":
		return serve(s, *addr)
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func serve(s *Store, addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("pilot service refuses non-loopback listeners")
		}
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	srv := &http.Server{
		Handler: newAPI(s), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	log.Printf("ND Cloud PILOT listening on %s (loopback only; NOT production)", listener.Addr().String())
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return nil
	}
}
