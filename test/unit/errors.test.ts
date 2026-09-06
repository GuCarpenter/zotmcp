import { expect } from "chai";
import { describeError, NotFoundError, TimeoutError } from "../../src/errors";

describe("describeError", function () {
  it("uses the message of a typed error", function () {
    expect(describeError(new NotFoundError("item", "ABCD1234"))).to.include(
      "ABCD1234",
    );
    expect(describeError(new TimeoutError('Write "tags"', 45000))).to.include(
      "45000 ms",
    );
  });

  it("passes a string through", function () {
    expect(describeError("plain trouble")).to.equal("plain trouble");
  });

  it("reads name and message off an error that lost its prototype", function () {
    // An error thrown across a sandbox boundary can arrive as a plain object;
    // JSON.stringify of it yields {"name":"TimeoutError"}, which says nothing.
    expect(
      describeError({ name: "TimeoutError", message: "took too long" }),
    ).to.equal("TimeoutError: took too long");
    expect(describeError({ name: "TimeoutError" })).to.equal("TimeoutError");
    expect(describeError({ message: "no name here" })).to.equal("no name here");
  });

  it("falls back to JSON for anything else", function () {
    expect(describeError({ code: 7 })).to.equal('{"code":7}');
  });
});
