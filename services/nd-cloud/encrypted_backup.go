package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const (
	encryptedBackupVersion = 1
	encryptedBackupKDF     = "PBKDF2-HMAC-SHA256"
	encryptedBackupRounds  = 300_000
	encryptedBackupAAD     = "ND Cloud encrypted backup v1"
)

type EncryptedBackupEnvelope struct {
	FormatVersion int       `json:"format_version"`
	KDF           string    `json:"kdf"`
	Iterations    int       `json:"iterations"`
	Salt          string    `json:"salt"`
	Nonce         string    `json:"nonce"`
	Ciphertext    string    `json:"ciphertext"`
	CreatedAt     time.Time `json:"created_at"`
}

// deriveBackupKey is PBKDF2-HMAC-SHA256 with one 32-byte output block.
// This standard-library-only pilot deliberately pins the iteration count.
func deriveBackupKey(passphrase string, salt []byte, rounds int) ([32]byte, error) {
	var key [32]byte
	if rounds != encryptedBackupRounds || len(salt) != 16 || len(passphrase) < 16 {
		return key, errInvalid
	}
	block := make([]byte, len(salt)+4)
	copy(block, salt)
	binary.BigEndian.PutUint32(block[len(salt):], 1)
	mac := hmac.New(sha256.New, []byte(passphrase))
	_, _ = mac.Write(block)
	u := mac.Sum(nil)
	copy(key[:], u)
	for i := 1; i < rounds; i++ {
		mac.Reset()
		_, _ = mac.Write(u)
		u = mac.Sum(u[:0])
		for j := 0; j < len(key); j++ {
			key[j] ^= u[j]
		}
	}
	return key, nil
}

func (s *Store) exportEncryptedBackup(destination, passphrase string) error {
	if strings.TrimSpace(destination) == "" || sameFilePath(destination, s.path) {
		return errInvalid
	}
	if _, err := os.Lstat(destination); err == nil {
		return errConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(passphrase) < 16 {
		return errors.New("backup passphrase must contain at least 16 characters")
	}
	var raw []byte
	s.read(func(st State) { raw, _ = json.Marshal(st) })
	if len(raw) == 0 || len(raw) > maxBackupBytes {
		return errInvalid
	}

	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	key, err := deriveBackupKey(passphrase, salt, encryptedBackupRounds)
	if err != nil {
		return err
	}
	defer clear(key[:])
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	envelope := EncryptedBackupEnvelope{
		FormatVersion: encryptedBackupVersion, KDF: encryptedBackupKDF,
		Iterations: encryptedBackupRounds, Salt: base64.RawStdEncoding.EncodeToString(salt),
		Nonce: base64.RawStdEncoding.EncodeToString(nonce), CreatedAt: time.Now().UTC(),
	}
	ciphertext := gcm.Seal(nil, nonce, raw, backupAuthenticatedMetadata(envelope))
	envelope.Ciphertext = base64.RawStdEncoding.EncodeToString(ciphertext)
	b, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return err
	}
	return persistNoReplace(destination, append(b, '\n'))
}

func restoreEncryptedBackup(source, destination, passphrase string) error {
	if strings.TrimSpace(source) == "" || strings.TrimSpace(destination) == "" || sameFilePath(source, destination) {
		return errInvalid
	}
	if len(passphrase) < 16 {
		return errInvalid
	}
	if _, err := os.Lstat(destination); err == nil {
		return errConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	b, err := privateRegularFile(source)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.DisallowUnknownFields()
	var envelope EncryptedBackupEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return errInvalid
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errInvalid
	}
	if envelope.FormatVersion != encryptedBackupVersion || envelope.KDF != encryptedBackupKDF || envelope.Iterations != encryptedBackupRounds {
		return errInvalid
	}
	salt, err := base64.RawStdEncoding.DecodeString(envelope.Salt)
	if err != nil || len(salt) != 16 {
		return errInvalid
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil || len(nonce) != 12 {
		return errInvalid
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil || len(ciphertext) < 16 || len(ciphertext) > maxBackupBytes+16 {
		return errInvalid
	}
	key, err := deriveBackupKey(passphrase, salt, envelope.Iterations)
	if err != nil {
		return err
	}
	defer clear(key[:])
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, backupAuthenticatedMetadata(envelope))
	if err != nil {
		return fmt.Errorf("encrypted backup authentication failed: %w", errInvalid)
	}
	state, err := normalizedState(plaintext)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := persistNoReplace(destination, append(encoded, '\n')); err != nil {
		return err
	}
	if _, err := openStore(destination); err != nil {
		_ = os.Remove(destination)
		return err
	}
	return nil
}

func clear(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// Any change to the backup timestamp or envelope parameters invalidates the
// GCM tag, not just changes to ciphertext. The ciphertext field is excluded.
func backupAuthenticatedMetadata(envelope EncryptedBackupEnvelope) []byte {
	return []byte(fmt.Sprintf("%s|%d|%s|%d|%s|%s|%s", encryptedBackupAAD,
		envelope.FormatVersion, envelope.KDF, envelope.Iterations, envelope.Salt,
		envelope.Nonce, envelope.CreatedAt.UTC().Format(time.RFC3339Nano)))
}
