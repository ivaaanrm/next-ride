import { describe, expect, it } from "vitest";

import { adminClient, Client, signedUpClient, unique } from "./client";

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

async function invite(email = `${unique("guest")}@next-ride.test`) {
  const admin = await adminClient();
  const res = await admin.post("/api/v1/invitations", { email });
  expect(res.status).toBe(201);
  return { admin, email, res, token: tokenOf(res.body.invite_url) };
}

describe("invitaciones", () => {
  it("solo un superusuario invita", async () => {
    expect((await new Client().post("/api/v1/invitations", { email: "x@next-ride.test" })).status).toBe(401);
    const user = await signedUpClient();
    expect((await user.post("/api/v1/invitations", { email: "x@next-ride.test" })).status).toBe(403);
    expect((await user.get("/api/v1/invitations")).status).toBe(403);
  });

  it("invitar, ver el formulario, aceptar y entrar", async () => {
    const { admin, email, res, token } = await invite(`  ${unique("Ana").toUpperCase()}@Next-Ride.test `);
    expect(res.body).toMatchObject({ email: email.trim().toLowerCase(), status: "pending", email_sent: true });
    expect(res.body.invite_url).toMatch(/^http:\/\/next-ride\.test\/invite\?token=[\w-]{43}$/);
    expect(res.body.email_sent_at).not.toBeNull();

    const guest = new Client();
    const lookup = await guest.post("/api/v1/invitations/lookup", { token });
    expect(lookup.status).toBe(200);
    expect(lookup.body.email).toBe(res.body.email);

    const accept = await guest.post("/api/v1/invitations/accept", {
      token,
      name: "Ana",
      password: "supersecret123",
    });
    expect(accept.status).toBe(201);

    const signIn = await guest.post("/api/auth/sign-in/email", {
      email: res.body.email,
      password: "supersecret123",
    });
    expect(signIn.status).toBe(200);
    const me = await guest.get("/api/v1/auth/me");
    expect(me.body).toMatchObject({ email: res.body.email, full_name: "Ana", is_superuser: false });

    const list = await admin.get("/api/v1/invitations");
    expect(list.body.find((row: any) => row.id === res.body.id).status).toBe("accepted");
  });

  it("el enlace sirve una sola vez", async () => {
    const { token } = await invite();
    const body = { token, password: "supersecret123" };
    expect((await new Client().post("/api/v1/invitations/accept", body)).status).toBe(201);
    const again = await new Client().post("/api/v1/invitations/accept", body);
    expect(again.status).toBe(410);
    expect(again.body.detail).toMatch(/ya se ha usado/);
    expect((await new Client().post("/api/v1/invitations/lookup", { token })).status).toBe(410);
  });

  it("reinvitar anula el enlace anterior, y revocar anula el actual", async () => {
    const { admin, email, token: first } = await invite();
    const second = await admin.post("/api/v1/invitations", { email });
    expect((await new Client().post("/api/v1/invitations/lookup", { token: first })).body.detail).toMatch(/anulado/);

    expect((await admin.delete(`/api/v1/invitations/${second.body.id}`)).status).toBe(204);
    const res = await new Client().post("/api/v1/invitations/accept", {
      token: tokenOf(second.body.invite_url),
      password: "supersecret123",
    });
    expect(res.status).toBe(410);
  });

  it("no se invita a quien ya tiene cuenta", async () => {
    const admin = await adminClient();
    const res = await admin.post("/api/v1/invitations", { email: "admin@next-ride.test" });
    expect(res.status).toBe(409);
  });

  it("un token inventado es 404 y una contraseña corta no gasta el enlace", async () => {
    const fake = await new Client().post("/api/v1/invitations/lookup", { token: "x".repeat(43) });
    expect(fake.status).toBe(404);

    const { token } = await invite();
    const short = await new Client().post("/api/v1/invitations/accept", { token, password: "corta" });
    expect(short.status).toBe(422);
    expect((await new Client().post("/api/v1/invitations/lookup", { token })).status).toBe(200);
  });
});
