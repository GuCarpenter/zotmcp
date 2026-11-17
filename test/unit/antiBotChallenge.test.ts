import { expect } from "chai";
import { looksLikeAntiBotChallenge } from "../../src/services/zoteroGateway";

describe("looksLikeAntiBotChallenge", function () {
  it("flags Cloudflare's Just a moment interstitial", function () {
    expect(
      looksLikeAntiBotChallenge(
        "<html><head><title>Just a moment...</title></head><body></body></html>",
      ),
    ).to.equal(true);
  });

  it("flags the challenge-platform script and enable-javascript prompt", function () {
    expect(
      looksLikeAntiBotChallenge(
        '<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
      ),
    ).to.equal(true);
    expect(
      looksLikeAntiBotChallenge(
        "<html><body>Enable JavaScript and cookies to continue</body></html>",
      ),
    ).to.equal(true);
  });

  it("passes an ordinary article, even one that mentions Cloudflare", function () {
    expect(
      looksLikeAntiBotChallenge(
        "<html><head><title>How Cloudflare works</title></head><body><article>Cloudflare is a CDN...</article></body></html>",
      ),
    ).to.equal(false);
    expect(looksLikeAntiBotChallenge("")).to.equal(false);
  });
});
