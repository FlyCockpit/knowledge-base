CC ?= gcc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -D_GNU_SOURCE
LDFLAGS ?=

.PHONY: all clean

all: kb-supervisor

kb-supervisor: kb-supervisor.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f kb-supervisor
