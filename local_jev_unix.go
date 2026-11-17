//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func configureJevProcess(cmd *exec.Cmd)  { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func stopJevProcess(cmd *exec.Cmd) error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
func killJevProcess(cmd *exec.Cmd)       { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
