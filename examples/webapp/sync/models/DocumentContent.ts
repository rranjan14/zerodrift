import { BaseModel, ClientModel, Property, Reference, LoadStrategy } from "zerodrift";
import type { Issue } from "./Issue";

@ClientModel({ name: "DocumentContent", loadStrategy: LoadStrategy.Partial })
export class DocumentContent extends BaseModel {
  @Property()
  public content = "";

  @Property({ indexed: true })
  public issueId = "";

  @Reference("Issue")
  public issue: Issue;
}
