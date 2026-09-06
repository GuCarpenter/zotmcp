import { expect } from "chai";
import { ScriptService, toJsonSafe } from "../../src/services/scriptService";
import { MutationService } from "../../src/services/mutationService";
import { FakeGateway } from "./fakeGateway";

describe("scriptService", function () {
  let gateway: FakeGateway;
  let service: ScriptService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new ScriptService(gateway, new MutationService(gateway));
  });

  it("returns a JSON-safe result and echoes the description", async function () {
    gateway.scriptImplementation = () => ({ count: 3 });

    const result = await service.run({
      mode: "read",
      script: "return { count: 3 };",
      description: "count something",
    });

    expect(result.ok).to.equal(true);
    expect(result.result).to.deep.equal({ count: 3 });
    expect(result.resultType).to.equal("object");
    expect(result.description).to.equal("count something");
  });

  it("collects env.log output", async function () {
    gateway.scriptImplementation = (env: any) => {
      env.log("first", { a: 1 });
      env.log("second");
      return null;
    };

    const result = await service.run({ mode: "read", script: "..." });

    expect(result.logs).to.deep.equal(['first {"a":1}', "second"]);
  });

  it("exposes the library ID and a deadline to the script", async function () {
    let seen: any;
    gateway.scriptImplementation = (env: any) => {
      seen = {
        libraryID: env.libraryID,
        remaining: env.remainingMs(),
        stop: env.shouldStop(),
      };
      return true;
    };

    await service.run({ mode: "read", script: "...", timeoutMs: 5000 });

    expect(seen.libraryID).to.equal(gateway.userLibraryID);
    expect(seen.remaining).to.be.greaterThan(0);
    expect(seen.stop).to.equal(false);
  });

  it("reports a thrown error with its stack rather than succeeding", async function () {
    gateway.scriptImplementation = () => {
      throw new Error("boom inside the script");
    };

    const result = await service.run({ mode: "read", script: "throw ..." });

    expect(result.ok).to.equal(false);
    expect(result.error?.message).to.equal("boom inside the script");
    expect(result.error?.stack).to.be.a("string");
  });

  it("aborts a script that overruns its deadline", async function () {
    gateway.scriptImplementation = () => new Promise(() => {});

    const result = await service.run({
      mode: "read",
      script: "while (true) {}",
      timeoutMs: 20,
    });

    expect(result.ok).to.equal(false);
    expect(result.error?.message).to.include("20 ms");
  });

  it("routes a write script through the write queue", async function () {
    gateway.scriptImplementation = () => "written";

    const result = await service.run({ mode: "write", script: "..." });

    expect(result.mode).to.equal("write");
    expect(result.ok).to.equal(true);
  });

  it("rejects a missing mode or empty script", async function () {
    for (const bad of [
      { mode: "sideways", script: "x" },
      { mode: "read", script: "" },
      { mode: "read", script: 42 },
    ]) {
      let error: any;
      try {
        await service.run(bad as never);
      } catch (e) {
        error = e;
      }
      expect(error?.code, JSON.stringify(bad)).to.equal("invalid_argument");
    }
  });

  it("caps the timeout", function () {
    expect(service.normalizeTimeout(999_999)).to.equal(120_000);
    expect(service.normalizeTimeout(undefined)).to.equal(30_000);
  });

  describe("result coercion", function () {
    it("reports a script that returned nothing", function () {
      const { result, resultType, note } = toJsonSafe(undefined);
      expect(result).to.equal(null);
      expect(resultType).to.equal("undefined");
      expect(note).to.include("return statement");
    });

    it("stringifies a circular object instead of dropping it", function () {
      const circular: any = { name: "loop" };
      circular.self = circular;

      const { result, note } = toJsonSafe(circular);

      expect(result).to.be.a("string");
      expect(note).to.include("not JSON-serializable");
    });

    it("carries a BigInt across as a string", function () {
      const { result, note } = toJsonSafe(10n);
      expect(result).to.equal("10");
      expect(note).to.include("BigInt");
    });

    it("stringifies a returned function", function () {
      const { result, note } = toJsonSafe(() => 1);
      expect(result).to.be.a("string");
      expect(note).to.include("function");
    });

    it("passes plain data through untouched", function () {
      expect(toJsonSafe([1, "two", null]).result).to.deep.equal([
        1,
        "two",
        null,
      ]);
      expect(toJsonSafe(null).resultType).to.equal("null");
    });
  });
});
