//go:build windows

package main

import (
	"os/exec"
	"strconv"
)

func configureJevProcess(cmd *exec.Cmd) { configureProcess(cmd) }
func stopJevProcess(cmd *exec.Cmd) error {
	c := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	configureProcess(c)
	return c.Run()
}
func killJevProcess(cmd *exec.Cmd) { stopJevProcess(cmd) }
