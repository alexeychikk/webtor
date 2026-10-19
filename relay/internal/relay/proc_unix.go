//go:build unix

package relay

import (
	"os/exec"
	"syscall"
)

// setProcessGroup runs cmd in its own process group and makes the context's cancel kill the whole
// group, so nothing ffmpeg starts outlives the job.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
