/*
 * Volume-wide kernel fence and descendant supervisor for the knowledge-base
 * server. Holds a never-unlinked flock for the process lifetime, runs as
 * subreaper, and is the only spawn path for mutating Git children.
 *
 * Errors name operation IDs only — never argv, env values, or document bodies.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define DRAIN_MS 5000
/* Node: 60s push + 5s child drain + 15s HTTP + 5s teardown.
 * Allow another 5s before forced teardown; container grace is >=100s.
 * lifecycle.test.ts checks these budgets against the Node constants. */
#define GRACEFUL_SHUTDOWN_MS 90000
#define MAX_OPS 64
#define MAX_ARGS 32
#define MAX_STR 4096
#define MAX_OP_ID 128
#define MAX_FRAME 65536
/* The environment is bounded by the spawn frame's bytes, not by an entry count: each
 * encoded entry costs at least 4 length bytes, so a frame carries at most
 * MAX_FRAME / 4 of them. A per-ref Git config allowlist needs many small entries. */
#define MAX_ENV (MAX_FRAME / 4)
#define MAX_OUT (MAX_FRAME * 4)
#define FENCE_REL ".private/server.fence"

#define MSG_SPAWN 1
#define MSG_DRAIN 2
#define MSG_CLOSE 3
#define MSG_PING 4
#define MSG_SHUTDOWN 5
#define MSG_SPAWNED 101
#define MSG_EXITED 102
#define MSG_ERR 103
#define MSG_PONG 104

#define ERR_INVALID 1
#define ERR_ADMISSION 2
#define ERR_SPAWN 3
#define ERR_NOT_FOUND 4
#define ERR_INTERNAL 5

struct op {
	int used;
	int draining;
	int leader_exited;
	int kill_recorded;
	pid_t pid;
	pid_t pgid;
	int64_t term_at_ms;
	char op_id[MAX_OP_ID];
	int exit_code;
};

static int fence_fd = -1;
static int worker_fence_fd = -1;
static int offline_backup = 0;
static int offline_restore = 0;
static int offline_maintenance = 0;
static int worker_role = 0;
static int listen_fd = -1;
static int client_fd = -1;
static pid_t client_pid = -1;
static int sigfd = -1;
static int admission = 1;
static int shutting_down = 0;
static int64_t graceful_at_ms = 0;
static pid_t node_pid = -1;
static int node_exit = 0;
static int node_exited = 0;
static struct op ops[MAX_OPS];
static char sock_env[64];
static uint8_t inbuf[MAX_FRAME + 8];
static size_t inlen;
static uint8_t outbuf[MAX_OUT];
static size_t outlen;
static char fence_path[512];

static void begin_shutdown(const char *why);

static int64_t now_ms(void)
{
	struct timespec ts;
	if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
		return 0;
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/*
 * Typed records, never free text. Each site, level and message is the exact
 * entry in packages/env/src/log.ts LOG_SITES (kb-process.test.ts cross-checks
 * this table), so the output supervisor validates and publishes them like any
 * service record. KB_LOG_FD names the service record channel; without
 * it (offline backup/restore, fence fixtures) the same records go to stderr.
 */
static int record_fd = 2;

enum record_site {
	REC_FATAL,
	REC_SHUTDOWN,
	REC_ADMISSION,
	REC_OP_SPAWNED,
	REC_OP_REAPED,
	REC_OP_REJECTED,
	REC_OP_DRAIN,
	REC_OP_KILL,
};
static const char *const record_sites[][3] = {
	[REC_FATAL] = {"supervisor.fatal", "error", "native supervisor could not start"},
	[REC_SHUTDOWN] = {"supervisor.shutdown", "info", "native supervisor shutdown started"},
	[REC_ADMISSION] = {"supervisor.admission-closed", "info", "native supervisor closed operation admission"},
	[REC_OP_SPAWNED] = {"supervisor.op-spawned", "info", "fenced operation spawned"},
	[REC_OP_REAPED] = {"supervisor.op-reaped", "info", "fenced operation group reaped"},
	[REC_OP_REJECTED] = {"supervisor.op-rejected", "warn", "fenced operation request rejected"},
	[REC_OP_DRAIN] = {"supervisor.op-drain", "warn", "fenced operation drain started"},
	[REC_OP_KILL] = {"supervisor.op-kill", "error", "fenced operation killed after drain timeout"},
};

/* Distinct exit statuses for each startup failure (also the record's exitCode). */
enum fatal_reason {
	FATAL_USAGE = 80,
	FATAL_SUBREAPER = 81,
	FATAL_DATA_ROOT = 82,
	FATAL_FENCE_PATH = 83,
	FATAL_FENCE_UNAVAILABLE = 84,
	FATAL_FENCE_HELD = 85,
	FATAL_WORKER_FENCE = 86,
	FATAL_FENCE_REPLACED = 87,
	FATAL_RESTORE_FENCE = 88,
	FATAL_CONTROL_SOCKET = 89,
	FATAL_SIGNALS = 90,
	FATAL_SPAWN = 91,
	FATAL_EXEC = 92,
};
static const char *fatal_name(enum fatal_reason reason)
{
	switch (reason) {
	case FATAL_USAGE: return "USAGE";
	case FATAL_SUBREAPER: return "SUBREAPER_UNAVAILABLE";
	case FATAL_DATA_ROOT: return "DATA_ROOT_MISSING";
	case FATAL_FENCE_PATH: return "FENCE_PATH_TOO_LONG";
	case FATAL_FENCE_UNAVAILABLE: return "FENCE_UNAVAILABLE";
	case FATAL_FENCE_HELD: return "FENCE_HELD";
	case FATAL_WORKER_FENCE: return "WORKER_FENCE_UNAVAILABLE";
	case FATAL_FENCE_REPLACED: return "FENCE_REPLACED";
	case FATAL_RESTORE_FENCE: return "RESTORE_FENCE_INIT_FAILED";
	case FATAL_CONTROL_SOCKET: return "CONTROL_SOCKET_FAILED";
	case FATAL_SIGNALS: return "SIGNALS_UNAVAILABLE";
	case FATAL_SPAWN: return "SPAWN_FAILED";
	case FATAL_EXEC: return "EXEC_FAILED";
	}
	return "USAGE";
}

/* The record validator's identifier rule: ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ */
static int safe_text(const char *s)
{
	size_t n = s ? strlen(s) : 0;
	if (n == 0 || n > 128)
		return 0;
	for (size_t i = 0; i < n; i++) {
		char c = s[i];
		int alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
		if (!alnum && (i == 0 || (c != '_' && c != '.' && c != ':' && c != '-')))
			return 0;
	}
	return 1;
}

/* One complete line per write(2): well under PIPE_BUF, so never interleaved. */
static void emit_record(enum record_site site, const char *op_id, const char *reason, int exit_code)
{
	char line[512];
	int n = snprintf(line, sizeof line, "{\"level\":\"%s\",\"site\":\"%s\",\"message\":\"%s\"",
			 record_sites[site][1], record_sites[site][0], record_sites[site][2]);
	if (n > 0 && safe_text(op_id))
		n += snprintf(line + n, sizeof line - (size_t)n, ",\"opId\":\"%s\"", op_id);
	if (n > 0 && safe_text(reason))
		n += snprintf(line + n, sizeof line - (size_t)n, ",\"reason\":\"%s\"", reason);
	if (n > 0 && exit_code >= 0)
		n += snprintf(line + n, sizeof line - (size_t)n, ",\"exitCode\":%d", exit_code);
	if (n <= 0 || (size_t)n + 2 > sizeof line)
		return;
	line[n++] = '}';
	line[n++] = '\n';
	ssize_t w;
	do
		w = write(record_fd, line, (size_t)n);
	while (w < 0 && errno == EINTR);
}

static void die(enum fatal_reason reason)
{
	emit_record(REC_FATAL, NULL, fatal_name(reason), (int)reason);
	exit((int)reason);
}

static uint16_t rd_u16(const uint8_t **p, const uint8_t *end, int *ok)
{
	if (*p + 2 > end) {
		*ok = 0;
		return 0;
	}
	uint16_t v = (uint16_t)(((*p)[0] << 8) | (*p)[1]);
	*p += 2;
	return v;
}

static uint32_t rd_u32(const uint8_t **p, const uint8_t *end, int *ok)
{
	if (*p + 4 > end) {
		*ok = 0;
		return 0;
	}
	uint32_t v = ((uint32_t)(*p)[0] << 24) | ((uint32_t)(*p)[1] << 16) |
		     ((uint32_t)(*p)[2] << 8) | (uint32_t)(*p)[3];
	*p += 4;
	return v;
}

static int rd_str(const uint8_t **p, const uint8_t *end, char *out, size_t cap)
{
	int ok = 1;
	uint16_t n = rd_u16(p, end, &ok);
	if (!ok || *p + n > end || n >= cap)
		return -1;
	memcpy(out, *p, n);
	out[n] = 0;
	*p += n;
	return (int)n;
}

static void wr_u16(uint8_t **p, const uint8_t *end, uint16_t v, int *ok)
{
	if (*p + 2 > end) {
		*ok = 0;
		return;
	}
	(*p)[0] = (uint8_t)(v >> 8);
	(*p)[1] = (uint8_t)v;
	*p += 2;
}

static void wr_u32(uint8_t **p, const uint8_t *end, uint32_t v, int *ok)
{
	if (*p + 4 > end) {
		*ok = 0;
		return;
	}
	(*p)[0] = (uint8_t)(v >> 24);
	(*p)[1] = (uint8_t)(v >> 16);
	(*p)[2] = (uint8_t)(v >> 8);
	(*p)[3] = (uint8_t)v;
	*p += 4;
}

static void wr_i32(uint8_t **p, const uint8_t *end, int32_t v, int *ok)
{
	wr_u32(p, end, (uint32_t)v, ok);
}

static void wr_str(uint8_t **p, const uint8_t *end, const char *s, int *ok)
{
	size_t n = s ? strlen(s) : 0;
	if (n > 0xffff) {
		*ok = 0;
		return;
	}
	wr_u16(p, end, (uint16_t)n, ok);
	if (!*ok || *p + n > end) {
		*ok = 0;
		return;
	}
	if (n)
		memcpy(*p, s, n);
	*p += n;
}

static void close_client(void)
{
	if (client_fd >= 0) {
		close(client_fd);
		client_fd = -1;
		client_pid = -1;
	}
	inlen = 0;
	outlen = 0;
}

static void control_lost(const char *why)
{
	close_client();
	begin_shutdown(why);
}

static int flush_out(void)
{
	if (client_fd < 0 || outlen == 0)
		return 0;
	while (outlen > 0) {
		ssize_t w = send(client_fd, outbuf, outlen, MSG_NOSIGNAL);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				return 0;
			control_lost("CONTROL_WRITE_FAILED");
			return -1;
		}
		if (w == 0) {
			control_lost("CONTROL_WRITE_FAILED");
			return -1;
		}
		memmove(outbuf, outbuf + (size_t)w, outlen - (size_t)w);
		outlen -= (size_t)w;
	}
	return 0;
}

static void send_frame(uint8_t type, const uint8_t *payload, size_t n)
{
	uint32_t len;
	size_t need;
	if (client_fd < 0)
		return;
	need = 5 + n;
	if (need > MAX_OUT - outlen) {
		control_lost("CONTROL_OUTPUT_OVERFLOW");
		return;
	}
	len = (uint32_t)n + 1;
	outbuf[outlen++] = (uint8_t)(len >> 24);
	outbuf[outlen++] = (uint8_t)(len >> 16);
	outbuf[outlen++] = (uint8_t)(len >> 8);
	outbuf[outlen++] = (uint8_t)len;
	outbuf[outlen++] = type;
	if (n > 0) {
		memcpy(outbuf + outlen, payload, n);
		outlen += n;
	}
	(void)flush_out();
}

static const char *err_name(uint32_t code)
{
	switch (code) {
	case ERR_INVALID: return "INVALID_REQUEST";
	case ERR_ADMISSION: return "ADMISSION_CLOSED";
	case ERR_SPAWN: return "SPAWN_FAILED";
	case ERR_NOT_FOUND: return "OPERATION_NOT_FOUND";
	}
	return "INTERNAL";
}

static void send_err(const char *op_id, uint32_t code, const char *msg)
{
	uint8_t buf[512];
	uint8_t *p = buf;
	int ok = 1;
	wr_str(&p, buf + sizeof buf, op_id ? op_id : "", &ok);
	wr_u32(&p, buf + sizeof buf, code, &ok);
	wr_str(&p, buf + sizeof buf, msg, &ok);
	if (ok)
		send_frame(MSG_ERR, buf, (size_t)(p - buf));
	emit_record(REC_OP_REJECTED, op_id, err_name(code), -1);
}

static void send_spawned(const char *op_id, pid_t pid)
{
	uint8_t buf[256];
	uint8_t *p = buf;
	int ok = 1;
	wr_str(&p, buf + sizeof buf, op_id, &ok);
	wr_u32(&p, buf + sizeof buf, (uint32_t)pid, &ok);
	if (ok)
		send_frame(MSG_SPAWNED, buf, (size_t)(p - buf));
}

static void send_exited(const char *op_id, pid_t pid, int code)
{
	uint8_t buf[256];
	uint8_t *p = buf;
	int ok = 1;
	wr_str(&p, buf + sizeof buf, op_id, &ok);
	wr_u32(&p, buf + sizeof buf, (uint32_t)pid, &ok);
	wr_i32(&p, buf + sizeof buf, code, &ok);
	if (ok)
		send_frame(MSG_EXITED, buf, (size_t)(p - buf));
}

static int wait_status_code(int status)
{
	if (WIFEXITED(status))
		return WEXITSTATUS(status);
	if (WIFSIGNALED(status))
		return 128 + WTERMSIG(status);
	return 1;
}

static struct op *find_op_pid(pid_t pid)
{
	for (int i = 0; i < MAX_OPS; i++) {
		if (ops[i].used && ops[i].pid == pid)
			return &ops[i];
	}
	return NULL;
}

static struct op *alloc_op(void)
{
	for (int i = 0; i < MAX_OPS; i++) {
		if (!ops[i].used)
			return &ops[i];
	}
	return NULL;
}

static pid_t read_ppid(pid_t pid)
{
	char path[64];
	char buf[4096];
	int n;
	int fd;

	n = snprintf(path, sizeof path, "/proc/%d/stat", pid);
	if (n < 0 || n >= (int)sizeof path)
		return -1;
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return -1;
	n = (int)read(fd, buf, sizeof buf - 1);
	close(fd);
	if (n <= 0)
		return -1;
	buf[n] = 0;
	char *rparen = strrchr(buf, ')');
	if (!rparen)
		return -1;
	char state;
	int ppid;
	if (sscanf(rparen + 2, "%c %d", &state, &ppid) != 2)
		return -1;
	return (pid_t)ppid;
}

static void reset_child_signals(void)
{
	sigset_t empty;
	struct sigaction sa;

	sigemptyset(&empty);
	(void)sigprocmask(SIG_SETMASK, &empty, NULL);
	memset(&sa, 0, sizeof sa);
	sa.sa_handler = SIG_DFL;
	sigemptyset(&sa.sa_mask);
	(void)sigaction(SIGTERM, &sa, NULL);
	(void)sigaction(SIGINT, &sa, NULL);
	(void)sigaction(SIGHUP, &sa, NULL);
	(void)sigaction(SIGCHLD, &sa, NULL);
	(void)sigaction(SIGPIPE, &sa, NULL);
}

static void kill_pid(pid_t pid, int sig)
{
	if (pid <= 0)
		return;
	if (kill(pid, sig) != 0 && errno != ESRCH) {
		/* ignore */
	}
}

static void kill_pg(pid_t pgid, int sig)
{
	if (pgid <= 0)
		return;
	if (kill(-pgid, sig) != 0 && errno != ESRCH)
		kill_pid(pgid, sig);
}

static void kill_direct_children(int sig)
{
	DIR *d = opendir("/proc");
	struct dirent *ent;
	pid_t me = getpid();
	if (!d)
		return;
	while ((ent = readdir(d)) != NULL) {
		char *end = NULL;
		long pid = strtol(ent->d_name, &end, 10);
		if (!end || *end != 0 || pid <= 0)
			continue;
		if ((pid_t)pid == me)
			continue;
		if (read_ppid((pid_t)pid) == me)
			kill_pid((pid_t)pid, sig);
	}
	closedir(d);
	for (int i = 0; i < MAX_OPS; i++) {
		if (ops[i].used)
			kill_pg(ops[i].pgid, sig);
	}
}

static int pg_alive(pid_t pgid)
{
	if (pgid <= 1)
		return 0;
	if (kill(-pgid, 0) == 0)
		return 1;
	return errno != ESRCH;
}

static void complete_empty_ops(void)
{
	for (int i = 0; i < MAX_OPS; i++) {
		struct op *op = &ops[i];
		int status = 0;
		pid_t w;

		if (!op->used)
			continue;
		if (pg_alive(op->pgid))
			continue;
		if (!op->leader_exited) {
			w = waitpid(op->pid, &status, WNOHANG);
			if (w == op->pid) {
				op->exit_code = wait_status_code(status);
				op->leader_exited = 1;
			} else if (w < 0 && errno == ECHILD) {
				if (!op->leader_exited)
					op->exit_code = 1;
				op->leader_exited = 1;
			} else {
				continue;
			}
		}
		send_exited(op->op_id, op->pid, op->exit_code);
		emit_record(REC_OP_REAPED, op->op_id, NULL, op->exit_code);
		op->used = 0;
		op->draining = 0;
	}
}

static void begin_drain_op(struct op *op)
{
	if (!op || !op->used || op->draining)
		return;
	op->draining = 1;
	op->term_at_ms = now_ms();
	kill_pg(op->pgid, SIGTERM);
	emit_record(REC_OP_DRAIN, op->op_id, NULL, -1);
}

static void reap_one(pid_t pid, int status)
{
	int code = wait_status_code(status);
	if (pid == node_pid) {
		node_exited = 1;
		node_exit = code;
		complete_empty_ops();
		return;
	}
	struct op *op = find_op_pid(pid);
	if (op) {
		op->leader_exited = 1;
		op->exit_code = code;
	}
	complete_empty_ops();
}

static void reap_all(void)
{
	int status;
	pid_t pid;
	while ((pid = waitpid(-1, &status, WNOHANG)) > 0)
		reap_one(pid, status);
	complete_empty_ops();
}

static int live_ops(void)
{
	int n = 0;
	for (int i = 0; i < MAX_OPS; i++) {
		if (ops[i].used)
			n++;
	}
	return n;
}

static void tick_drains(void)
{
	int64_t now = now_ms();
	for (int i = 0; i < MAX_OPS; i++) {
		struct op *op = &ops[i];
		if (!op->used || !op->draining)
			continue;
		if (now - op->term_at_ms >= DRAIN_MS) {
			kill_pg(op->pgid, SIGKILL);
			if (!op->kill_recorded) {
				op->kill_recorded = 1;
				emit_record(REC_OP_KILL, op->op_id, NULL, -1);
			}
		}
	}
	reap_all();
}

static int drain_timeout_ms(void)
{
	int64_t now = now_ms();
	int ms = -1;
	for (int i = 0; i < MAX_OPS; i++) {
		struct op *op = &ops[i];
		if (!op->used || !op->draining)
			continue;
		int64_t left = DRAIN_MS - (now - op->term_at_ms);
		if (left < 0)
			left = 0;
		if (ms < 0 || left < ms)
			ms = (int)left;
	}
	return ms;
}

static void begin_shutdown(const char *why)
{
	if (shutting_down)
		return;
	shutting_down = 1;
	admission = 0;
	emit_record(REC_SHUTDOWN, NULL, why, -1);
	if (!node_exited && node_pid > 0)
		kill_pid(node_pid, SIGTERM);
	for (int i = 0; i < MAX_OPS; i++) {
		if (ops[i].used)
			begin_drain_op(&ops[i]);
	}
	kill_direct_children(SIGTERM);
}

static void begin_graceful_shutdown(void)
{
	if (shutting_down || graceful_at_ms)
		return;
	graceful_at_ms = now_ms();
	emit_record(REC_SHUTDOWN, NULL, "GRACEFUL", -1);
	/* Node closes operation admission and joins committed reservations before
	 * MSG_CLOSE. Keep spawn available for their remaining publication work.
	 * Control loss or Node death still enters immediate forced teardown. */
	kill_pid(node_pid, SIGTERM);
}

static void handle_spawn(const uint8_t *body, size_t n)
{
	const uint8_t *p = body;
	const uint8_t *end = body + n;
	char op_id[MAX_OP_ID];
	char cwd[MAX_STR];
	char *argv[MAX_ARGS + 1];
	/* Single-threaded: one spawn is decoded at a time, and fork() copies these. Every
	 * stored "key=value\0" is no longer than its encoded form (two u16 lengths), so
	 * the packed store never outgrows the frame. */
	static char *envp[MAX_ENV + 1];
	static char envstore[MAX_FRAME];
	size_t envused = 0;
	char argstore[MAX_ARGS][MAX_STR];
	int argc;
	int envc;
	int i;

	if (rd_str(&p, end, op_id, sizeof op_id) < 0) {
		send_err("", ERR_INVALID, "invalid spawn header");
		return;
	}
	if (!admission || shutting_down) {
		send_err(op_id, ERR_ADMISSION, "admission closed");
		return;
	}
	if (rd_str(&p, end, cwd, sizeof cwd) < 0) {
		send_err(op_id, ERR_INVALID, "invalid spawn cwd");
		return;
	}
	int ok = 1;
	argc = rd_u16(&p, end, &ok);
	if (!ok || argc < 1 || argc > MAX_ARGS) {
		send_err(op_id, ERR_INVALID, "invalid spawn argc");
		return;
	}
	for (i = 0; i < argc; i++) {
		if (rd_str(&p, end, argstore[i], MAX_STR) < 0) {
			send_err(op_id, ERR_INVALID, "invalid spawn argv");
			return;
		}
		argv[i] = argstore[i];
	}
	argv[argc] = NULL;
	envc = rd_u16(&p, end, &ok);
	if (!ok || envc < 0 || envc > MAX_ENV) {
		send_err(op_id, ERR_INVALID, "invalid spawn envc");
		return;
	}
	for (i = 0; i < envc; i++) {
		char key[256];
		char val[MAX_STR];
		if (rd_str(&p, end, key, sizeof key) < 0 ||
		    rd_str(&p, end, val, sizeof val) < 0) {
			send_err(op_id, ERR_INVALID, "invalid spawn env");
			return;
		}
		size_t klen = strlen(key);
		size_t vlen = strlen(val);
		if (klen == 0 || memchr(key, '=', klen) ||
		    klen + vlen + 2 > sizeof envstore - envused) {
			send_err(op_id, ERR_INVALID, "invalid spawn env");
			return;
		}
		envp[i] = envstore + envused;
		memcpy(envstore + envused, key, klen);
		envstore[envused + klen] = '=';
		memcpy(envstore + envused + klen + 1, val, vlen);
		envstore[envused + klen + 1 + vlen] = 0;
		envused += klen + vlen + 2;
	}
	envp[envc] = NULL;

	struct op *op = alloc_op();
	if (!op) {
		send_err(op_id, ERR_SPAWN, "too many operations");
		return;
	}

	pid_t pid = fork();
	if (pid < 0) {
		send_err(op_id, ERR_SPAWN, "fork failed");
		return;
	}
	if (pid == 0) {
		reset_child_signals();
		if (setpgid(0, 0) != 0)
			_exit(127);
		if (prctl(PR_SET_PDEATHSIG, 0) != 0) {
			/* keep the fence fd; parent-death signal would drop it. */
		}
		if (fcntl(fence_fd, F_SETFD, 0) != 0)
			_exit(127);
		if (cwd[0] && chdir(cwd) != 0)
			_exit(127);
		if (listen_fd >= 0)
			close(listen_fd);
		if (client_fd >= 0)
			close(client_fd);
		if (sigfd >= 0)
			close(sigfd);
		execvpe(argv[0], argv, envc > 0 ? envp : environ);
		_exit(127);
	}
	if (setpgid(pid, pid) != 0 && errno != EACCES && errno != ESRCH) {
		/* child may already have set it */
	}
	memset(op, 0, sizeof *op);
	op->used = 1;
	op->pid = pid;
	op->pgid = pid;
	snprintf(op->op_id, sizeof op->op_id, "%s", op_id);
	send_spawned(op_id, pid);
	emit_record(REC_OP_SPAWNED, op_id, NULL, -1);
}

static void handle_drain(const uint8_t *body, size_t n)
{
	const uint8_t *p = body;
	const uint8_t *end = body + n;
	char op_id[MAX_OP_ID];
	int ok = 1;
	if (rd_str(&p, end, op_id, sizeof op_id) < 0) {
		send_err("", ERR_INVALID, "invalid drain header");
		return;
	}
	uint32_t pid = rd_u32(&p, end, &ok);
	if (!ok) {
		send_err(op_id, ERR_INVALID, "invalid drain pid");
		return;
	}
	struct op *op = find_op_pid((pid_t)pid);
	if (!op || strcmp(op->op_id, op_id) != 0) {
		send_err(op_id, ERR_NOT_FOUND, "operation not found");
		return;
	}
	begin_drain_op(op);
}

static void handle_frame(uint8_t type, const uint8_t *body, size_t n)
{
	switch (type) {
	case MSG_SPAWN:
		handle_spawn(body, n);
		break;
	case MSG_DRAIN:
		handle_drain(body, n);
		break;
	case MSG_CLOSE:
		admission = 0;
		emit_record(REC_ADMISSION, NULL, NULL, -1);
		break;
	case MSG_PING:
		send_frame(MSG_PONG, NULL, 0);
		break;
	case MSG_SHUTDOWN:
		begin_shutdown("CLIENT_SHUTDOWN");
		break;
	default:
		send_err("", ERR_INVALID, "unknown control message");
		break;
	}
}

static void consume_client(void)
{
	for (;;) {
		if (inlen < 4)
			return;
		uint32_t len = ((uint32_t)inbuf[0] << 24) | ((uint32_t)inbuf[1] << 16) |
			       ((uint32_t)inbuf[2] << 8) | (uint32_t)inbuf[3];
		if (len < 1 || len > MAX_FRAME) {
			send_err("", ERR_INVALID, "invalid frame");
			close_client();
			return;
		}
		if (inlen < 4 + len)
			return;
		handle_frame(inbuf[4], inbuf + 5, (size_t)len - 1);
		if (client_fd < 0)
			return;
		size_t used = 4 + len;
		if (used > inlen)
			return;
		memmove(inbuf, inbuf + used, inlen - used);
		inlen -= used;
	}
}

static void on_client_readable(void)
{
	if (client_fd < 0)
		return;
	if (inlen >= sizeof inbuf) {
		control_lost("CONTROL_INPUT_OVERFLOW");
		return;
	}
	ssize_t n = recv(client_fd, inbuf + inlen, sizeof inbuf - inlen, MSG_NOSIGNAL);
	if (n < 0) {
		if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
			return;
		n = 0;
	}
	if (n == 0) {
		const char *why = (node_exited || shutting_down)
					  ? "CONTROL_CHANNEL_CLOSED"
					  : "CONTROL_CHANNEL_LOST";
		control_lost(why);
		return;
	}
	inlen += (size_t)n;
	consume_client();
}

static void on_accept(void)
{
	int fd = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
	if (fd < 0)
		return;
	struct ucred cred;
	socklen_t clen = sizeof cred;
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &clen) != 0 ||
	    cred.uid != getuid() || node_pid <= 0 || cred.pid != node_pid) {
		close(fd);
		return;
	}
	if (client_fd >= 0) {
		close(fd);
		return;
	}
	client_fd = fd;
	client_pid = cred.pid;
	inlen = 0;
	outlen = 0;
}

static int backup_flock(int fd)
{
	static int64_t deadline;
	if (!deadline) {
		const char *raw = getenv("KB_BACKUP_FENCE_WAIT_MS");
		long wait = raw ? strtol(raw, NULL, 10) : 300000;
		if (wait < 1 || wait > 300000) return -1;
		deadline = now_ms() + wait;
		const char *absolute = getenv("KB_BACKUP_FENCE_DEADLINE_MS");
		if (absolute) {
			char *end;
			deadline = strtoll(absolute, &end, 10);
			int64_t remaining = deadline - now_ms();
			if (*end || remaining < 1 || remaining > 300000) return -1;
		}
	}
	if (now_ms() >= deadline) return -1;
	while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
		if (!offline_backup || (errno != EWOULDBLOCK && errno != EAGAIN) || now_ms() >= deadline) return -1;
		struct timespec pause = {0, 100000000};
		nanosleep(&pause, NULL);
	}
	return now_ms() < deadline ? 0 : -1;
}

/* Descriptor-relative no-follow lookup, including every parent component. */
static int open_fence_path(const char *path, int flags)
{
	char parts[512];
	if (path[0] != '/' || strlen(path) >= sizeof parts) return -1;
	strcpy(parts, path + 1);
	int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	char *save = NULL;
	char *part = strtok_r(parts, "/", &save);
	while (part && parent >= 0) {
		char *next = strtok_r(NULL, "/", &save);
		if (!strcmp(part, ".") || !strcmp(part, "..")) { close(parent); return -1; }
		int child = openat(parent, part, next ? O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC : flags | O_NOFOLLOW, 0600);
		close(parent); parent = child; part = next;
	}
	return parent;
}

static void acquire_fence(void)
{
	const char *data_root = getenv("KB_DATA_ROOT");
	char repos[512];
	struct stat st_fd;
	struct stat st_path;
	int n;

	if (!data_root || !data_root[0])
		die(FATAL_DATA_ROOT);
	/* Fences live under <KB_DATA_ROOT>/repos/.private on the one data volume. */
	n = snprintf(repos, sizeof repos, "%s/repos", data_root);
	if (n < 0 || n >= (int)sizeof repos)
		die(FATAL_FENCE_PATH);
	if (offline_restore || offline_maintenance) {
		int root = open_fence_path(data_root, O_RDONLY | O_DIRECTORY);
		if (root < 0 || (mkdirat(root, "repos", 0750) != 0 && errno != EEXIST))
			die(FATAL_RESTORE_FENCE);
		if (fsync(root) != 0) die(FATAL_RESTORE_FENCE);
		close(root);
		root = open_fence_path(repos, O_RDONLY | O_DIRECTORY);
		if (root < 0 || (mkdirat(root, ".private", 0700) != 0 && errno != EEXIST))
			die(FATAL_RESTORE_FENCE);
		if (fsync(root) != 0) die(FATAL_RESTORE_FENCE);
		close(root);
	}
	n = snprintf(fence_path, sizeof fence_path, "%s/%s", repos, worker_role ? ".private/worker.fence" : FENCE_REL);
	if (n < 0 || n >= (int)sizeof fence_path)
		die(FATAL_FENCE_PATH);
	fence_fd = open_fence_path(fence_path, ((offline_backup && !offline_restore && !offline_maintenance) || worker_role) ? O_RDONLY : O_RDWR | O_CREAT);
	if (fence_fd < 0)
		die(FATAL_FENCE_UNAVAILABLE);
	if (fcntl(fence_fd, F_SETFD, 0) != 0)
		die(FATAL_FENCE_UNAVAILABLE);
	if (backup_flock(fence_fd) != 0)
		die(FATAL_FENCE_HELD);
	if (offline_backup) {
		char worker_path[512];
		if (snprintf(worker_path, sizeof worker_path, "%s/.private/worker.fence", repos) >= (int)sizeof worker_path)
			die(FATAL_FENCE_PATH);
		worker_fence_fd = open_fence_path(worker_path, (offline_restore || offline_maintenance) ? O_RDWR | O_CREAT : O_RDONLY);
		if (worker_fence_fd < 0 || backup_flock(worker_fence_fd) != 0)
			die(FATAL_WORKER_FENCE);
		if (fstat(worker_fence_fd, &st_fd) != 0 || !S_ISREG(st_fd.st_mode))
			die(FATAL_WORKER_FENCE);
		if (offline_restore || offline_maintenance) {
			char private_path[512];
			if (snprintf(private_path, sizeof private_path, "%s/.private", repos) >= (int)sizeof private_path)
				die(FATAL_FENCE_PATH);
			int private_fd = open_fence_path(private_path, O_RDONLY | O_DIRECTORY);
			if (private_fd < 0 || fsync(private_fd) != 0)
				die(FATAL_RESTORE_FENCE);
			close(private_fd);
		}
	}
	if (fstat(fence_fd, &st_fd) != 0 || lstat(fence_path, &st_path) != 0)
		die(FATAL_FENCE_UNAVAILABLE);
	if (!S_ISREG(st_fd.st_mode) || S_ISLNK(st_path.st_mode) ||
	    st_fd.st_ino != st_path.st_ino || st_fd.st_dev != st_path.st_dev)
		die(FATAL_FENCE_REPLACED);
}

static void bind_control(void)
{
	struct sockaddr_un addr;
	int n;
	int one = 1;

	listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (listen_fd < 0)
		die(FATAL_CONTROL_SOCKET);
	memset(&addr, 0, sizeof addr);
	addr.sun_family = AF_UNIX;
	addr.sun_path[0] = '\0';
	n = snprintf(addr.sun_path + 1, sizeof(addr.sun_path) - 1, "kb-sup-%d",
		     getpid());
	if (n < 0 || n >= (int)sizeof(addr.sun_path) - 1)
		die(FATAL_CONTROL_SOCKET);
	socklen_t len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + n);
	if (bind(listen_fd, (struct sockaddr *)&addr, len) != 0)
		die(FATAL_CONTROL_SOCKET);
	if (listen(listen_fd, 4) != 0)
		die(FATAL_CONTROL_SOCKET);
	(void)setsockopt(listen_fd, SOL_SOCKET, SO_PASSCRED, &one, sizeof one);
	snprintf(sock_env, sizeof sock_env, "@kb-sup-%d", getpid());
	if (setenv("KB_SUPERVISOR_SOCK", sock_env, 1) != 0)
		die(FATAL_CONTROL_SOCKET);
	char fdstr[16];
	if (offline_backup) {
		snprintf(fdstr, sizeof fdstr, "%d", worker_fence_fd);
		if (setenv("KB_WORKER_FENCE_FD", fdstr, 1) != 0)
			die(FATAL_CONTROL_SOCKET);
	}
	snprintf(fdstr, sizeof fdstr, "%d", fence_fd);
	if (setenv("KB_FENCE_FD", fdstr, 1) != 0)
		die(FATAL_CONTROL_SOCKET);
}

static void spawn_node(char **argv)
{
	pid_t pid = fork();
	if (pid < 0)
		die(FATAL_SPAWN);
	if (pid == 0) {
		reset_child_signals();
		if (setpgid(0, 0) != 0)
			_exit(127);
		if (fcntl(fence_fd, F_SETFD, 0) != 0)
			_exit(127);
		if (listen_fd >= 0)
			close(listen_fd);
		if (sigfd >= 0)
			close(sigfd);
		execvp(argv[0], argv);
		emit_record(REC_FATAL, NULL, fatal_name(FATAL_EXEC), FATAL_EXEC);
		_exit(FATAL_EXEC);
	}
	if (setpgid(pid, pid) != 0 && errno != EACCES && errno != ESRCH) {
		/* child may already have set it */
	}
	node_pid = pid;
}

int main(int argc, char **argv)
{
	int argi = 1;
	/* The output supervisor names its record channel in KB_LOG_FD; a
	 * descriptor is never assumed (fd 3 could otherwise be the fence itself).
	 * The Node service below reads the same variable. */
	const char *log_fd = getenv("KB_LOG_FD");
	if (log_fd) {
		char *end;
		long fd = strtol(log_fd, &end, 10);
		struct stat st;
		if (*end || end == log_fd || fd < 3 || fd > 255 || fstat((int)fd, &st) != 0 ||
		    !(S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode)))
			die(FATAL_USAGE);
		record_fd = (int)fd;
	}
	if (argi < argc && (strcmp(argv[argi], "--backup") == 0 || strcmp(argv[argi], "--restore") == 0 || strcmp(argv[argi], "--asset-storage") == 0)) {
		offline_restore = strcmp(argv[argi], "--restore") == 0;
		offline_maintenance = strcmp(argv[argi], "--asset-storage") == 0;
		offline_backup = 1; admission = 0; argi++;
	} else if (argi < argc && strcmp(argv[argi], "--worker") == 0) {
		worker_role = 1; admission = 0; argi++;
	}
	if (argi < argc && strcmp(argv[argi], "--") == 0)
		argi++;
	if (argi >= argc)
		die(FATAL_USAGE);

	if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0)
		die(FATAL_SUBREAPER);

	acquire_fence();
	bind_control();

	sigset_t mask;
	sigemptyset(&mask);
	sigaddset(&mask, SIGCHLD);
	sigaddset(&mask, SIGTERM);
	sigaddset(&mask, SIGINT);
	sigaddset(&mask, SIGHUP);
	sigaddset(&mask, SIGPIPE);
	if (sigprocmask(SIG_BLOCK, &mask, NULL) != 0)
		die(FATAL_SIGNALS);
	sigfd = signalfd(-1, &mask, SFD_CLOEXEC);
	if (sigfd < 0)
		die(FATAL_SIGNALS);

	spawn_node(argv + argi);

	int64_t shutdown_at = 0;
	while (1) {
		reap_all();
		tick_drains();
		if (node_exited && !shutting_down)
			begin_shutdown("NODE_EXITED");
		if (graceful_at_ms && !shutting_down &&
		    now_ms() - graceful_at_ms >= (worker_role ? 300000 : GRACEFUL_SHUTDOWN_MS))
			begin_shutdown("GRACEFUL_DEADLINE");
		if (shutting_down) {
			if (shutdown_at == 0)
				shutdown_at = now_ms();
			if (!node_exited && now_ms() - shutdown_at >= 20000) {
				kill_pid(node_pid, SIGKILL);
			}
			if (now_ms() - shutdown_at >= DRAIN_MS) {
				kill_direct_children(SIGKILL);
				for (int i = 0; i < MAX_OPS; i++) {
					if (ops[i].used)
						kill_pg(ops[i].pgid, SIGKILL);
				}
			}
			reap_all();
			if (node_exited && live_ops() == 0) {
				/* Hold the fence until every descendant is reaped. */
				int status;
				pid_t leftover = waitpid(-1, &status, WNOHANG);
				if (leftover > 0)
					reap_one(leftover, status);
				else if (leftover < 0 && errno == ECHILD)
					break;
			}
		}

		struct pollfd pfds[3];
		int nfds = 0;
		pfds[nfds].fd = sigfd;
		pfds[nfds].events = POLLIN;
		nfds++;
		if (listen_fd >= 0) {
			pfds[nfds].fd = listen_fd;
			pfds[nfds].events = POLLIN;
			nfds++;
		}
		if (client_fd >= 0) {
			pfds[nfds].fd = client_fd;
			pfds[nfds].events = POLLIN;
			if (outlen > 0)
				pfds[nfds].events |= POLLOUT;
			nfds++;
		}
		int timeout = drain_timeout_ms();
		if (graceful_at_ms && !shutting_down) {
			int left = (int)((worker_role ? 300000 : GRACEFUL_SHUTDOWN_MS) - (now_ms() - graceful_at_ms));
			if (left < 0)
				left = 0;
			if (timeout < 0 || left < timeout)
				timeout = left;
		}
		if (shutting_down) {
			int left = (int)(DRAIN_MS - (now_ms() - shutdown_at));
			if (left < 0)
				left = 0;
			if (timeout < 0 || left < timeout)
				timeout = left;
		}
		int pr = poll(pfds, (nfds_t)nfds, timeout);
		if (pr < 0) {
			if (errno == EINTR)
				continue;
			begin_shutdown("POLL_FAILED");
			continue;
		}
		int idx = 0;
		if (pfds[idx].revents & POLLIN) {
			struct signalfd_siginfo info;
			ssize_t n = read(sigfd, &info, sizeof info);
			if (n == sizeof info) {
				if (info.ssi_signo == SIGCHLD)
					reap_all();
				else if (info.ssi_signo == SIGTERM ||
					 info.ssi_signo == SIGINT ||
					 info.ssi_signo == SIGHUP)
					begin_graceful_shutdown();
				/* SIGPIPE is blocked and ignored; writes use MSG_NOSIGNAL. */
			}
		}
		idx++;
		if (listen_fd >= 0) {
			if (pfds[idx].revents & POLLIN)
				on_accept();
			idx++;
		}
		if (client_fd >= 0 && idx < nfds) {
			if (pfds[idx].revents & POLLOUT)
				(void)flush_out();
			if (client_fd >= 0 &&
			    (pfds[idx].revents & (POLLIN | POLLHUP | POLLERR)))
				on_client_readable();
		}
	}

	/* Descriptor stays open until process exit so a leaked descendant
	 * cannot race a replacement writer. Never unlink the fence inode. */
	return node_exit;
}
