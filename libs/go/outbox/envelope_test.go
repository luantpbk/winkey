package outbox_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/outbox"
)

// The envelope must validate against the contract, together with the
// per-event schema, using the architect's example as event data.
func TestEnvelopeMatchesContract(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "contracts", "events")
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	for _, f := range []string{"envelope.schema.json", "video.uploaded.schema.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytesReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		id := "https://winkey.vn/contracts/events/" + f
		if err := c.AddResource(id, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := c.Compile("https://winkey.vn/contracts/events/video.uploaded.schema.json")
	if err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "examples", "video.uploaded.json"))
	if err != nil {
		t.Fatal(err)
	}
	var example struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &example); err != nil {
		t.Fatal(err)
	}

	outbox.SetProducer("upload-svc")
	_, payload, err := outbox.BuildEnvelope(context.Background(), "video.uploaded", json.RawMessage(example.Data))
	if err != nil {
		t.Fatal(err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytesReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(inst); err != nil {
		t.Fatalf("envelope violates contract: %v\n%s", err, payload)
	}
}
