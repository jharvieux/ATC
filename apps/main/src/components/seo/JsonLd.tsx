// Renders a schema.org graph as an inline ld+json script.
//
// The `<` escape is not optional: JSON.stringify happily emits a literal
// "</script>" if any string in the graph ever contains one, which closes the
// tag early and turns the rest of the payload into live markup. Today every
// graph here is built from static constants, but persona bios and tenant
// display names are one prop away, so the escape belongs at the sink.

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
