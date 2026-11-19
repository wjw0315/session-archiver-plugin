import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ArchiverPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addSurface("archiver", ArchiverPanel);
  client.addSidebarItem({
    id: "archiver",
    title: "Session Archiver",
    icon: "Archive",
    surface: "archiver",
  });
  return () => {};
}
