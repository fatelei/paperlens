//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func configureJevProcess(cmd *exec.Cmd) { configureProcess(cmd) }
func stopJevProcess(cmd *exec.Cmd) error {
	taskkill := "taskkill"
	if root := os.Getenv("SystemRoot"); root != "" {
		taskkill = filepath.Join(root, "System32", "taskkill.exe")
	}
	c := exec.Command(taskkill, "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	configureProcess(c)
	return c.Run()
}
func killJevProcess(cmd *exec.Cmd) { stopJevProcess(cmd) }
