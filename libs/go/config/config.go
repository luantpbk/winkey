// Package config loads service configuration from environment variables.
//
// Fields of a struct are described with tags:
//
//	type Config struct {
//	    DatabaseURL string        `env:"DATABASE_URL,required"`
//	    HTTPAddr    string        `env:"HTTP_ADDR" default:":8080"`
//	    Poll        time.Duration `env:"POLL" default:"500ms"`
//	}
//
// Load reports every missing or malformed variable at once, so a
// misconfigured deployment fails fast with a complete error message.
// Values are never included in errors (they may be secrets).
package config

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Load fills the struct pointed to by dst from the process environment.
func Load(dst any) error {
	return LoadFrom(dst, os.LookupEnv)
}

// LoadFrom is Load with an explicit lookup function (used by tests).
func LoadFrom(dst any, lookup func(string) (string, bool)) error {
	rv := reflect.ValueOf(dst)
	if rv.Kind() != reflect.Ptr || rv.Elem().Kind() != reflect.Struct {
		return errors.New("config: destination must be a pointer to a struct")
	}
	var errs []error
	load(rv.Elem(), lookup, &errs)
	return errors.Join(errs...)
}

var durationType = reflect.TypeOf(time.Duration(0))

func load(sv reflect.Value, lookup func(string) (string, bool), errs *[]error) {
	st := sv.Type()
	for i := 0; i < st.NumField(); i++ {
		f := st.Field(i)
		fv := sv.Field(i)
		if !f.IsExported() {
			continue
		}
		tag, ok := f.Tag.Lookup("env")
		if !ok {
			if f.Type.Kind() == reflect.Struct && f.Type != durationType {
				load(fv, lookup, errs)
			}
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		required := opts == "required"

		raw, found := lookup(name)
		if found && raw == "" {
			found = false // an empty variable counts as unset
		}
		if !found {
			def, hasDef := f.Tag.Lookup("default")
			switch {
			case hasDef:
				raw = def
			case required:
				*errs = append(*errs, fmt.Errorf("%s is required", name))
				continue
			default:
				continue
			}
		}
		if err := set(fv, raw); err != nil {
			*errs = append(*errs, fmt.Errorf("%s: %w", name, err))
		}
	}
}

func set(fv reflect.Value, raw string) error {
	if fv.Type() == durationType {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return errors.New("invalid duration")
		}
		fv.SetInt(int64(d))
		return nil
	}
	switch fv.Kind() {
	case reflect.String:
		fv.SetString(raw)
	case reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return errors.New("invalid boolean")
		}
		fv.SetBool(b)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(raw, 10, fv.Type().Bits())
		if err != nil {
			return errors.New("invalid integer")
		}
		fv.SetInt(n)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, err := strconv.ParseUint(raw, 10, fv.Type().Bits())
		if err != nil {
			return errors.New("invalid unsigned integer")
		}
		fv.SetUint(n)
	case reflect.Float32, reflect.Float64:
		n, err := strconv.ParseFloat(raw, fv.Type().Bits())
		if err != nil {
			return errors.New("invalid number")
		}
		fv.SetFloat(n)
	case reflect.Slice:
		if fv.Type().Elem().Kind() != reflect.String {
			return errors.New("unsupported slice type")
		}
		var out []string
		for _, p := range strings.Split(raw, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		fv.Set(reflect.ValueOf(out))
	default:
		return fmt.Errorf("unsupported type %s", fv.Type())
	}
	return nil
}
