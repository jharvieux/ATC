// #783 Phase 3 — Group creation page with cascade-dropdown sailing selection.

import * as React from "react";
import { CreateGroupClient } from "@/components/groups/CreateGroupClient";

export default function NewGroupPage(): React.ReactElement {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-[22px] font-bold mb-2">Create a group booking</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Select a sailing from the catalog, then add your invitees.
      </p>
      <CreateGroupClient />
    </div>
  );
}
