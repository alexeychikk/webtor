//go:build !unix

package relay

import "os/exec"

// setProcessGroup: without Unix process groups, CommandContext's default cancel kills ffmpeg itself.
func setProcessGroup(*exec.Cmd) {}
