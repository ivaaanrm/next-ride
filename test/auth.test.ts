import { describe, expect, it } from "vitest";

import { adminClient, Client, signedUpClient, unique } from "./client";

describe("health", () => {
  it("dice ok con el esquema al día", async () => {
    const res = await new Client().get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.schema.up_to_date).toBe(true);
    expect(res.body.schema.head).toBe("0001_seed_scraping.sql");
    expect(res.body.ai_enabled).toBe(false);
  });
});

describe("rutas", () => {
  it("una ruta desconocida de la API es 404 también sin sesión", async () => {
    const res = await new Client().get("/api/v1/no-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "Not Found" });
  });
});

describe("autenticación de personas (Better Auth)", () => {
  it("sin sesión, la API responde 401 con detail en español", async () => {
    const res = await new Client().get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Credenciales no válidas");
  });

  it("registro, /auth/me con la forma de siempre, y logout", async () => {
    const client = await signedUpClient("Ana");
    const me = await client.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ full_name: "Ana", is_active: true, is_superuser: false });
    expect(typeof me.body.id).toBe("string");
    expect(me.body.last_login_at).not.toBeNull();

    const out = await client.post("/api/auth/sign-out");
    expect(out.status).toBe(200);
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("el superusuario se siembra desde los secretos", async () => {
    const admin = await adminClient();
    const me = await admin.get("/api/v1/auth/me");
    expect(me.body).toMatchObject({ email: "admin@next-ride.test", is_superuser: true });
  });

  it("contraseña errónea no abre sesión", async () => {
    const res = await new Client().post("/api/auth/sign-in/email", {
      email: "admin@next-ride.test",
      password: "otra-cosa-123",
    });
    expect(res.status).toBe(401);
  });

  it("el registro no puede auto-asignarse superusuario", async () => {
    const client = new Client();
    const res = await client.post("/api/auth/sign-up/email", {
      email: `${unique("evil")}@next-ride.test`,
      password: "supersecret123",
      name: "Evil",
      isSuperuser: true,
    });
    if (res.status === 200) {
      const me = await client.get("/api/v1/auth/me");
      expect(me.body.is_superuser).toBe(false);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("expone si el registro está abierto y deja cambiar el nombre", async () => {
    expect((await new Client().get("/api/v1/auth/config")).body).toEqual({ registration_enabled: true });
    const client = await signedUpClient();
    const res = await client.patch("/api/v1/auth/me", { full_name: "Nuevo nombre" });
    expect(res.body.full_name).toBe("Nuevo nombre");
  });
});
