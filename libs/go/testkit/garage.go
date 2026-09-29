package testkit

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Garage image; pinned so tests are reproducible. The CLI syntax used below is
// the v1.x one.
const garageImage = "dxflrs/garage:v1.0.1"

// Fixed test credentials (Garage requires GK + 24 hex / 64 hex).
const (
	GarageAccessKey = "GK0123456789abcdef01234567"
	GarageSecretKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	GarageRegion    = "garage"
	RawBucket       = "winkey-raw"
	MediaBucket     = "winkey-media"
)

const garageConfig = `
metadata_dir = "/tmp/garage/meta"
data_dir = "/tmp/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "0.0.0.0:3901"
rpc_secret = "1799bccfd7411eddcf9ebd316bc1f5287ad12a68094e1c6ac6abde7e6feae1ec"

[s3_api]
s3_region = "garage"
api_bind_addr = "0.0.0.0:3900"
root_domain = ".s3.garage.localhost"
`

// Garage is a single-node Garage with both Winkey buckets and CORS on the raw
// bucket, reachable via path-style S3.
type Garage struct {
	Endpoint  string // http://host:port
	Region    string
	AccessKey string
	SecretKey string
	Container testcontainers.Container
}

// S3Client returns an aws-sdk-go-v2 client for the Garage node (path-style).
func (g *Garage) S3Client() *s3.Client {
	return s3.NewFromConfig(aws.Config{
		Region:      g.Region,
		Credentials: credentials.NewStaticCredentialsProvider(g.AccessKey, g.SecretKey, ""),
	}, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(g.Endpoint)
		o.UsePathStyle = true
	})
}

// StartGarage boots a single Garage node, applies a one-node layout, imports
// the test key, creates winkey-raw and winkey-media (key has full access) and
// sets CORS on winkey-raw (PUT/GET/HEAD from any origin, ETag exposed).
func StartGarage(t testing.TB) *Garage {
	t.Helper()
	requireDocker(t)
	ctx := context.Background()

	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        garageImage,
			ExposedPorts: []string{"3900/tcp"},
			Files: []testcontainers.ContainerFile{{
				Reader:            strings.NewReader(garageConfig),
				ContainerFilePath: "/etc/garage.toml",
				FileMode:          0o644,
			}},
			WaitingFor: wait.ForListeningPort("3900/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("testkit: start garage: %v", err)
	}
	testcontainers.CleanupContainer(t, c)

	// The image is FROM scratch: only the /garage binary can be exec'd.
	garage := func(args ...string) string {
		t.Helper()
		out, err := execGarage(ctx, c, args...)
		if err != nil {
			t.Fatalf("testkit: garage %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return out
	}

	nodeID := ""
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		out, err := execGarage(ctx, c, "node", "id", "-q")
		if err == nil {
			nodeID, _, _ = strings.Cut(strings.TrimSpace(out), "@")
			if nodeID != "" {
				break
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if nodeID == "" {
		t.Fatal("testkit: garage node id not available")
	}
	garage("layout", "assign", "-z", "dc1", "-c", "1G", nodeID)
	garage("layout", "apply", "--version", "1")
	garage("key", "import", "--yes", "-n", "winkey-test", GarageAccessKey, GarageSecretKey)
	for _, b := range []string{RawBucket, MediaBucket} {
		garage("bucket", "create", b)
		garage("bucket", "allow", "--read", "--write", "--owner", b, "--key", GarageAccessKey)
	}

	host, err := c.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := c.MappedPort(ctx, "3900/tcp")
	if err != nil {
		t.Fatal(err)
	}
	g := &Garage{
		Endpoint:  fmt.Sprintf("http://%s:%s", host, port.Port()),
		Region:    GarageRegion,
		AccessKey: GarageAccessKey,
		SecretKey: GarageSecretKey,
		Container: c,
	}

	cl := g.S3Client()
	var lastErr error
	for i := 0; i < 20; i++ { // layout propagation can take a moment
		_, lastErr = cl.PutBucketCors(ctx, &s3.PutBucketCorsInput{
			Bucket: aws.String(RawBucket),
			CORSConfiguration: &s3types.CORSConfiguration{CORSRules: []s3types.CORSRule{{
				AllowedOrigins: []string{"*"},
				AllowedMethods: []string{"PUT", "GET", "HEAD"},
				AllowedHeaders: []string{"*"},
				ExposeHeaders:  []string{"ETag"},
				MaxAgeSeconds:  aws.Int32(3600),
			}}},
		})
		if lastErr == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("testkit: put cors on %s: %v", RawBucket, lastErr)
	}
	return g
}

func execGarage(ctx context.Context, c testcontainers.Container, args ...string) (string, error) {
	code, r, err := c.Exec(ctx, append([]string{"/garage", "-c", "/etc/garage.toml"}, args...))
	if err != nil {
		return "", err
	}
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, r); err != nil && err != io.EOF {
		return "", err
	}
	out := stdout.String() + stderr.String()
	if code != 0 {
		return out, fmt.Errorf("exit code %d", code)
	}
	return stdout.String(), nil
}
