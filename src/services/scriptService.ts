/**
 * `zotero_script`: the escape hatch for anything the other tools do not cover.
 *
 * Deliberately ungated, per the project's decision that local clients may write
 * freely. What it does provide is a deadline, honest error reporting with the
 * stack, and a result that survives JSON — a script whose return value cannot be
 * serialized is reported, never silently dropped.
 */

import { InvalidArgumentError, TimeoutError } from "../errors";
import type { MutationService } from "./mutationService";
import { stageUndo, UNDO_ACTIONS } from "./undo";
import type { ZoteroGateway } from "./zoteroGateway";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
export const MAX_SCRIPT_TIMEOUT_MS = 120_000;

export type ScriptMode = "read" | "write";

export interface ScriptResult {
  mode: ScriptMode;
  /** True when the script ran inside one transaction and one undo step. */
  transactional?: boolean;
  description?: string;
  ok: boolean;
  /** JSON-safe form of whatever the script returned. */
  result?: unknown;
  resultType: string;
  logs: string[];
  error?: { message: string; stack?: string };
  note?: string;
}

export class ScriptService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly mutations: MutationService,
  ) {}

  public normalizeTimeout(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_SCRIPT_TIMEOUT_MS;
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 1) {
      throw new InvalidArgumentError(
        `Invalid timeoutMs ${JSON.stringify(value)}: expected a positive number ` +
          `up to ${MAX_SCRIPT_TIMEOUT_MS}.`,
      );
    }
    return Math.min(Math.floor(ms), MAX_SCRIPT_TIMEOUT_MS);
  }

  public async run(input: {
    mode: unknown;
    script: unknown;
    description?: string;
    timeoutMs?: unknown;
    transaction?: unknown;
  }): Promise<ScriptResult> {
    const mode = input.mode === "write" ? "write" : "read";
    if (input.mode !== "read" && input.mode !== "write") {
      throw new InvalidArgumentError(
        `"mode" must be "read" or "write", got ${JSON.stringify(input.mode)}.`,
      );
    }
    if (typeof input.script !== "string" || !input.script.trim()) {
      throw new InvalidArgumentError('"script" must be a non-empty string.');
    }

    const timeoutMs = this.normalizeTimeout(input.timeoutMs);
    const source = input.script;
    const transactional = input.transaction === true;

    if (transactional && mode !== "write") {
      throw new InvalidArgumentError(
        '"transaction" only applies to mode "write".',
      );
    }

    const execute = () =>
      this.execute(source, mode, timeoutMs, input.description, transactional);

    // A write script goes through the same queue as every other write, so it
    // cannot interleave with a concurrent tool call.
    if (mode !== "write") return execute();

    if (!transactional) return this.mutations.enqueue("script", execute);

    // Inside one transaction every save the script makes records its own
    // changes, and this label collapses them into a single undo step. The cost is
    // that the database is held for the script's whole run, so it is opt-in.
    return this.mutations.enqueueTransaction("script", async () => {
      stageUndo(this.gateway, UNDO_ACTIONS.script);
      return execute();
    });
  }

  private async execute(
    source: string,
    mode: ScriptMode,
    timeoutMs: number,
    description?: string,
    transactional = false,
  ): Promise<ScriptResult> {
    const logs: string[] = [];
    const startedAt = Date.now();
    let stopped = false;

    const env = {
      log: (...args: unknown[]) => {
        logs.push(args.map((arg) => stringify(arg)).join(" "));
      },
      libraryID: this.gateway.userLibraryID,
      /** True once the deadline has passed, so long loops can bail out. */
      shouldStop: () => stopped || Date.now() - startedAt >= timeoutMs,
      remainingMs: () => Math.max(0, timeoutMs - (Date.now() - startedAt)),
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        stopped = true;
        reject(new TimeoutError("Script", timeoutMs));
      }, timeoutMs);
    });

    try {
      const value = await Promise.race([
        this.gateway.runScript(source, env),
        deadline,
      ]);
      const { result, resultType, note } = toJsonSafe(value);

      return {
        mode,
        ...(transactional ? { transactional } : {}),
        ...(description ? { description } : {}),
        ok: true,
        result,
        resultType,
        logs,
        ...(note
          ? { note }
          : transactional
            ? {
                note:
                  "Ran inside one transaction, so the changes it saved are a " +
                  "single step on Zotero's undo stack.",
              }
            : {}),
      };
    } catch (e) {
      const error = e as Error;
      return {
        mode,
        ...(transactional ? { transactional } : {}),
        ...(description ? { description } : {}),
        ok: false,
        resultType: "error",
        logs,
        error: {
          message: error?.message ?? String(e),
          ...(error?.stack ? { stack: error.stack } : {}),
        },
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Coerces a script's return value into something JSON can carry, reporting when
 * the original shape could not survive the trip.
 */
export function toJsonSafe(value: unknown): {
  result: unknown;
  resultType: string;
  note?: string;
} {
  const resultType = describeType(value);

  if (value === undefined) {
    return {
      result: null,
      resultType: "undefined",
      note: "The script returned nothing; add a return statement to get a value back.",
    };
  }

  if (typeof value === "function") {
    return {
      result: String(value).slice(0, 500),
      resultType,
      note: "The script returned a function, which was stringified.",
    };
  }

  if (typeof value === "bigint") {
    return {
      result: value.toString(),
      resultType,
      note: "A BigInt was returned as a string, since JSON has no BigInt.",
    };
  }

  try {
    // Round-trips so circular structures and non-JSON values surface here rather
    // than when the response is serialized.
    return { result: JSON.parse(JSON.stringify(value)), resultType };
  } catch {
    return {
      result: String(value).slice(0, 1000),
      resultType,
      note:
        "The returned value is not JSON-serializable (it may be circular or a " +
        "Zotero object), so it was stringified. Return plain data for a " +
        "structured result.",
    };
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
