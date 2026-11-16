import { describe, it, expect } from "bun:test";
import { ok, okMany, fail, err, paginate, unwrap, isServiceError, tryCatch } from "./result";

// ==========================
// ok()
// ==========================

describe("ok()", () => {
  it("creates void success result", () => {
    const result = ok();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });

  it("creates success result with data", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it("creates success result with falsy data", () => {
    expect(ok(0).ok && ok(0)).toMatchObject({ ok: true, data: 0 });
    expect(ok("").ok && ok("")).toMatchObject({ ok: true, data: "" });
    expect(ok(false).ok && ok(false)).toMatchObject({ ok: true, data: false });
  });

  it("preserves null as data", () => {
    const result = ok(null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });
});

// ==========================
// okMany
// ==========================

describe("okMany", () => {
  it("creates paginated success with hasNext=true when more pages", () => {
    const result = okMany([1, 2], { page: 1, perPage: 2, total: 5 });
    if (result.ok) {
      expect(result.data.hasNext).toBe(true);
      expect(result.data.items).toEqual([1, 2]);
    }
  });

  it("creates paginated success with hasNext=false on last page", () => {
    const result = okMany([5], { page: 3, perPage: 2, total: 5 });
    if (result.ok) expect(result.data.hasNext).toBe(false);
  });

  it("works with empty items array", () => {
    const result = okMany([], { page: 1, perPage: 10, total: 0 });
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.hasNext).toBe(false);
    }
  });
});

// ==========================
// fail
// ==========================

describe("fail", () => {
  it("creates error result", () => {
    const result = fail(err.notFound("User"));
    expect(result.ok).toBe(false);
  });

  it("preserves error properties", () => {
    const result = fail(err.badInput("bad"));
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toBe("bad");
      expect(result.error.status).toBe(400);
    }
  });
});

// ==========================
// err helpers
// ==========================

describe("err helpers", () => {
  it("badInput has code BAD_INPUT and status 400", () => {
    const e = err.badInput("oops");
    expect(e.code).toBe("BAD_INPUT");
    expect(e.status).toBe(400);
    expect(e.message).toBe("oops");
  });

  it("unauthenticated uses default message when none given", () => {
    expect(err.unauthenticated().message).toBe("Authentication required");
  });

  it("forbidden uses default message when none given", () => {
    expect(err.forbidden().message).toBe("Insufficient permissions");
  });

  it("notFound appends 'not found'", () => {
    expect(err.notFound("User").message).toBe("User not found");
  });

  it("conflict takes its sentence as given and appends nothing", () => {
    expect(err.conflict("Email already exists").message).toBe("Email already exists");
    expect(err.conflict("Task changed; read it and retry").message).toBe("Task changed; read it and retry");
    expect(err.conflict("Email").message).toBe("Email");
  });

  it("internal uses default message when none given", () => {
    expect(err.internal().message).toBe("Internal server error");
  });

  it("each helper has correct status code", () => {
    const cases: [() => any, number][] = [
      [() => err.badInput("x"), 400],
      [() => err.unauthenticated(), 401],
      [() => err.forbidden(), 403],
      [() => err.notFound("x"), 404],
      [() => err.conflict("x"), 409],
      [() => err.internal(), 500],
    ];
    for (const [factory, status] of cases) {
      expect(factory().status).toBe(status);
    }
  });
});

// ==========================
// paginate
// ==========================

describe("paginate", () => {
  it("returns defaults when no params given", () => {
    expect(paginate()).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it("calculates correct offset", () => {
    expect(paginate({ page: 3, perPage: 10 })).toEqual({ page: 3, perPage: 10, offset: 20 });
  });

  it("handles page 1 explicitly", () => {
    expect(paginate({ page: 1, perPage: 5 })).toEqual({ page: 1, perPage: 5, offset: 0 });
  });

  it("clamps negative page to 1", () => {
    expect(paginate({ page: -1, perPage: 10 })).toEqual({ page: 1, perPage: 10, offset: 0 });
  });

  it("clamps zero perPage to 1", () => {
    expect(paginate({ page: 1, perPage: 0 })).toEqual({ page: 1, perPage: 1, offset: 0 });
  });
});

// ==========================
// unwrap
// ==========================

describe("unwrap", () => {
  it("returns data from ok result", () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it("throws error from fail result", () => {
    expect(() => unwrap(fail(err.notFound("x")))).toThrow();
  });

  it("thrown error is the ServiceError object", () => {
    try {
      unwrap(fail(err.notFound("x")));
    } catch (e: any) {
      expect(e.code).toBe("NOT_FOUND");
      expect(e.status).toBe(404);
    }
  });
});

// ==========================
// isServiceError
// ==========================

describe("isServiceError", () => {
  it("returns true for valid ServiceError shape", () => {
    expect(isServiceError({ code: "X", message: "y", status: 400 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isServiceError(null)).toBe(false);
  });

  it("returns false for plain string", () => {
    expect(isServiceError("error")).toBe(false);
  });

  it("returns false for object missing code", () => {
    expect(isServiceError({ message: "y", status: 400 })).toBe(false);
  });

  it("returns false for object with wrong types", () => {
    expect(isServiceError({ code: 123, message: "y", status: 400 })).toBe(false);
  });
});

// ==========================
// tryCatch
// ==========================

describe("tryCatch", () => {
  it("wraps successful async result in ok", async () => {
    const result = await tryCatch(() => Promise.resolve(42));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it("wraps thrown ServiceError in fail preserving error", async () => {
    const result = await tryCatch(() => {
      throw err.notFound("X");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("wraps thrown Error using internal by default", async () => {
    const result = await tryCatch(() => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toBe("boom");
    }
  });

  it("uses custom onError mapper when provided", async () => {
    const result = await tryCatch(
      () => { throw "x"; },
      () => err.badInput("custom"),
    );
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  });

  it("wraps non-Error throw via String()", async () => {
    const result = await tryCatch(() => { throw 42; });
    if (!result.ok) expect(result.error.message).toContain("42");
  });

  // Regression: onError throwing must not break the never-throws contract.
  it("never throws even when onError itself throws", async () => {
    const result = await tryCatch(
      async () => {
        throw new Error("boom");
      },
      () => {
        throw new Error("mapping crashed");
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });
});

// ==========================
// paginate (regression)
// ==========================

describe("paginate (regression)", () => {
  it("coerces NaN/Infinity to defaults", () => {
    const r = paginate({ page: NaN as any, perPage: Infinity as any });
    expect(Number.isFinite(r.page)).toBe(true);
    expect(Number.isFinite(r.perPage)).toBe(true);
    expect(Number.isFinite(r.offset)).toBe(true);
  });

  it("clamps oversize perPage to a sane maximum", () => {
    const r = paginate({ page: 1, perPage: 1_000_000 });
    expect(r.perPage).toBeLessThanOrEqual(1000);
  });

  it("floors fractional values", () => {
    const r = paginate({ page: 2.7, perPage: 10.9 });
    expect(r.page).toBe(2);
    expect(r.perPage).toBe(10);
  });

  it("rejects negative values via Math.max(1, ...)", () => {
    const r = paginate({ page: -5, perPage: -10 });
    expect(r.page).toBe(1);
    expect(r.perPage).toBe(1);
  });
});
