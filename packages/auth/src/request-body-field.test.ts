import { describe, expect, it } from "vitest";
import { readBodyFields } from "./request-body-field";

const post = (body: string, type: string | null) =>
  new Request("https://app.example.test/", {
    method: "POST",
    headers: type === null ? {} : { "content-type": type },
    body,
  });

const email = async (request: Request) => (await readBodyFields(request, { email: 320 })).email;

describe("readBodyFields", () => {
  it("reads string fields from a JSON or a form body", async () => {
    expect(
      await readBodyFields(post('{"email":"a@b.test","password":"pw"}', "application/json"), {
        email: 320,
        password: 128,
      }),
    ).toEqual({ email: "a@b.test", password: "pw" });
    expect(
      await email(post("email=a%40b.test&password=x", "application/x-www-form-urlencoded")),
    ).toBe("a@b.test");
  });

  // better-call lower-cases the type before matching, so these all reach
  // Better-Auth's handler as the parsed body; the fields must match it.
  it.each([
    ["Application/X-WWW-Form-Urlencoded", "email=a%40b.test"],
    ["application/x-www-form-urlencoded; charset=UTF-8", "email=a%40b.test"],
    ["APPLICATION/X-WWW-FORM-URLENCODED;CHARSET=utf-8", "email=a%40b.test"],
    ["Application/JSON", '{"email":"a@b.test"}'],
    ["application/json; charset=utf-8", '{"email":"a@b.test"}'],
    ["application/vnd.api+json", '{"email":"a@b.test"}'],
  ])("parses %s like Better-Auth", async (type, body) => {
    expect(await email(post(body, type))).toBe("a@b.test");
  });

  it("keeps the LAST value of a repeated form field, as Better-Auth does", async () => {
    expect(
      await email(
        post("email=first%40b.test&email=last%40b.test", "application/x-www-form-urlencoded"),
      ),
    ).toBe("last@b.test");
  });

  it("decodes form text with UTF-8, plus signs and malformed escapes like formData", async () => {
    expect(
      await readBodyFields(
        post(
          "email=a%2Bb%40test&password=caf%C3%A9+%ZZ%FF&token=a=b",
          "application/x-www-form-urlencoded; charset=iso-8859-1",
        ),
        { email: 320, password: 128, token: 512 },
      ),
    ).toEqual({ email: "a+b@test", password: "café %ZZ�", token: "a=b" });
  });

  it("reads multipart text fields, keeps the last duplicate, and leaves the handler's body intact", async () => {
    const form = new FormData();
    form.append("email", "first@example.test");
    form.append("email", "last@example.test");
    form.append("password", "secret+ café");
    form.append("token", "reset-token");
    form.append("userId", "target-user");
    const request = new Request("https://app.example.test/", { method: "POST", body: form });
    expect(
      await readBodyFields(request.clone(), { email: 320, password: 128, token: 512, userId: 256 }),
    ).toEqual({
      email: "last@example.test",
      password: "secret+ café",
      token: "reset-token",
      userId: "target-user",
    });
    expect((await request.formData()).getAll("email")).toEqual([
      "first@example.test",
      "last@example.test",
    ]);
  });

  it("does not treat a multipart file replacing a text field as a string", async () => {
    const form = new FormData();
    form.append("email", "first@example.test");
    form.append("email", new Blob(["last@example.test"]), "email.txt");
    const request = new Request("https://app.example.test/", { method: "POST", body: form });
    expect(await email(request)).toBeNull();
  });

  it("returns no fields for malformed multipart or a misleading form content type", async () => {
    expect(await email(post("not multipart", "multipart/form-data; boundary=missing"))).toBeNull();
    expect(
      await email(post("email=a%40b.test", "text/plain; application/x-www-form-urlencoded")),
    ).toBeNull();
  });

  it("reads no fields from a body Better-Auth would not parse as an object", async () => {
    expect(await email(post('{"email":"a@b.test"}', null))).toBeNull();
    expect(await email(post('{"email":"a@b.test"}', "text/plain"))).toBeNull();
  });

  it("answers null for a missing, empty, non-string or oversized field and an unparseable body", async () => {
    const json = (body: string) => post(body, "application/json");
    expect(await email(json("{}"))).toBeNull();
    expect(await email(json('{"email":""}'))).toBeNull();
    expect(await email(json('{"email":7}'))).toBeNull();
    expect(await email(json(JSON.stringify({ email: "x".repeat(321) })))).toBeNull();
    expect(await email(json("not json"))).toBeNull();
    expect(await email(json("null"))).toBeNull();
  });
});
