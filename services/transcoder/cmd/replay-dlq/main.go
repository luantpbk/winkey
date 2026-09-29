// Command replay-dlq re-publishes dlq.video.uploaded messages to
// video.uploaded after the cause of the failures has been fixed.
//
//	NATS_URL=nats://... replay-dlq -dry-run
//	NATS_URL=nats://... replay-dlq -video-id <uuid>
//	NATS_URL=nats://... replay-dlq -max 10
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/services/transcoder/internal/worker"
)

func main() {
	max := flag.Int("max", 0, "replay at most this many messages (0 = all)")
	videoID := flag.String("video-id", "", "only replay messages for this video")
	dry := flag.Bool("dry-run", false, "list what would be replayed without publishing")
	flag.Parse()

	url := os.Getenv("NATS_URL")
	if url == "" {
		fmt.Fprintln(os.Stderr, "NATS_URL is required")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	nc, err := nats.Connect(url, nats.Name("replay-dlq"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	rep, err := worker.ReplayDLQ(ctx, js, worker.ReplayOptions{Max: *max, VideoID: *videoID, DryRun: *dry})
	verb := "replayed"
	if *dry {
		verb = "would replay"
	}
	fmt.Printf("examined %d DLQ messages; %s %d\n", rep.Seen, verb, rep.Matched)
	for _, id := range rep.VideoIDs {
		fmt.Println("  video", id)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}
