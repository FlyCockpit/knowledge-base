/** better-call's JSON test (`utils.mjs` `jsonContentTypeRegex`), on the lower-cased type. */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/**
 * String fields of a request body, read the way Better-Auth's router
 * (better-call `getBody`) reads it, so the value seen here is the value the
 * handler sees: the content type is lower-cased, a JSON type
 * (`application/json`, `application/*+json`, any parameters) parses as JSON,
 * otherwise a type containing `application/x-www-form-urlencoded` or
 * `multipart/form-data` parses as a form where a repeated field keeps its
 * LAST value. Multipart files are not string fields. Anything else has no fields.
 *
 * Each field is null when it is absent, empty, not a string, longer than its
 * limit, or the body does not parse. Reads the request it is given, so pass a
 * clone when the handler still needs the body.
 */
export async function readBodyFields<K extends string>(
  request: Request,
  limits: Record<K, number>,
): Promise<Record<K, string | null>> {
  const keys = Object.keys(limits) as K[];
  const fields = Object.fromEntries(keys.map((key) => [key, null])) as Record<K, string | null>;
  let body: Record<string, unknown> = {};
  try {
    const type = (request.headers.get("content-type") ?? "").toLowerCase();
    if (JSON_MEDIA_TYPE.test(type)) {
      const parsed: unknown = await request.json();
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } else if (type.includes(FORM_MEDIA_TYPE) || type.includes("multipart/form-data")) {
      const form = await request.formData();
      // getAll is available in both DOM and React Native types. Read only the
      // requested fields, retaining better-call 1.4.5's last-value semantics.
      for (const key of keys) {
        body[key] = form.getAll(key).at(-1);
      }
    }
  } catch {
    return fields;
  }
  for (const key of keys) {
    const value = Reflect.get(body, key);
    if (typeof value === "string" && value.length > 0 && value.length <= limits[key]) {
      fields[key] = value;
    }
  }
  return fields;
}
