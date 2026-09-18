/**
 * EPUB CFI locating, the bridge between the gateway's raw spine (zip + parsed
 * XHTML) and the pure CFI arithmetic in `epubCfi.ts`.
 *
 * It owns no Zotero surface of its own — `readEpubSpine` does the privileged
 * work — so it stays unit-testable against the fake gateway.
 */

import { locateTextInSpine, type EpubTextMatch } from "./epubCfi";
import type { ZoteroGateway } from "./zoteroGateway";

export type { EpubTextMatch } from "./epubCfi";

export class EpubCfiService {
  constructor(private readonly gateway: ZoteroGateway) {}

  /**
   * Every occurrence of `text` in the EPUB, each with a point CFI, a range CFI
   * and a sortIndex. Empty when the attachment is not an EPUB, its file cannot
   * be read, or the text does not appear verbatim in a single text node.
   */
  public async locate(
    attachment: Zotero.Item,
    text: string,
  ): Promise<EpubTextMatch[]> {
    const needle = (text ?? "").trim();
    if (!needle) return [];

    const spine = await this.gateway.readEpubSpine(attachment);
    if (!spine) return [];

    return locateTextInSpine(spine, needle);
  }
}
