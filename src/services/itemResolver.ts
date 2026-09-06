/**
 * The single door for turning a caller-supplied key into a Zotero object.
 *
 * Zotero keys are unique per library, not globally, so a group-library key can
 * collide with a different My Library object. Every lookup therefore asserts the
 * resolved object's `libraryID`, which is what makes spec LB-2 impossible to
 * violate from a forgotten call site.
 */

import {
  GroupLibraryUnsupportedError,
  InvalidArgumentError,
  NotFoundError,
} from "../errors";
import type { ZoteroGateway } from "./zoteroGateway";

const ITEM_KEY_RE = /^[A-Z0-9]{8}$/;

export class ItemResolver {
  constructor(private readonly gateway: ZoteroGateway) {}

  public assertKeyShape(kind: string, key: unknown): string {
    if (typeof key !== "string" || !ITEM_KEY_RE.test(key)) {
      throw new InvalidArgumentError(
        `Invalid ${kind} key ${JSON.stringify(key)}: expected an 8-character ` +
          `Zotero key such as "ABCD1234".`,
      );
    }
    return key;
  }

  public async resolveItem(key: unknown): Promise<Zotero.Item> {
    const itemKey = this.assertKeyShape("item", key);
    const item = await this.gateway.getItemByKey(
      this.gateway.userLibraryID,
      itemKey,
    );
    if (!item) throw new NotFoundError("item", itemKey);
    this.assertUserLibrary("item", itemKey, item.libraryID);
    return item;
  }

  public async resolveAttachment(key: unknown): Promise<Zotero.Item> {
    const item = await this.resolveItem(key);
    if (!item.isAttachment()) {
      throw new InvalidArgumentError(
        `Item "${item.key}" is not an attachment (item type ` +
          `"${item.itemType}"). Pass an attachment key.`,
      );
    }
    return item;
  }

  public async resolveCollection(key: unknown): Promise<Zotero.Collection> {
    const collectionKey = this.assertKeyShape("collection", key);
    const collection = await this.gateway.getCollectionByKey(
      this.gateway.userLibraryID,
      collectionKey,
    );
    if (!collection) throw new NotFoundError("collection", collectionKey);
    this.assertUserLibrary("collection", collectionKey, collection.libraryID);
    return collection;
  }

  /**
   * Guards objects obtained by numeric ID or from a Zotero callback, where the
   * library was never constrained by the lookup itself.
   */
  public assertUserLibraryObject(
    kind: string,
    key: string,
    libraryID: number,
  ): void {
    this.assertUserLibrary(kind, key, libraryID);
  }

  public isUserLibrary(libraryID: number): boolean {
    return libraryID === this.gateway.userLibraryID;
  }

  private assertUserLibrary(
    kind: string,
    key: string,
    libraryID: number,
  ): void {
    if (libraryID !== this.gateway.userLibraryID) {
      throw new GroupLibraryUnsupportedError(kind, key, libraryID);
    }
  }
}
