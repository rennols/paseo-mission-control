/**
 * Branch row badges (PRD: Branch row badges). A workspace row in Paseo's sidebar gets a short badge
 * while an agent in it has an open Needs you item: approve, question, stuck or over 45m. Rows with
 * nothing open render nothing. Every badge carries text, never colour alone.
 *
 * Every row renders the component, so the client entry holds one subscription and the rows read
 * from it; the server pushes only when the badges change.
 */
import type { PluginClientContext, PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge, type WorkspaceRowBadgeProps } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { rowBadgesWatch, type NeedsKind, type RowBadge } from "../shared/live";

const TONE: Record<NeedsKind, NonNullable<WorkspaceRowBadgeProps["tone"]>> = {
  permission: "warning",
  question: "warning",
  stuck: "danger",
  overtime: "info",
};

const ICON: Record<NeedsKind, string> = {
  permission: "ShieldAlert",
  question: "MessageCircleQuestion",
  stuck: "CircleAlert",
  overtime: "Timer",
};

type Badges = Record<string, RowBadge[]>;

let current: Badges = {};
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: Badges): void {
  current = next;
  for (const listener of listeners) listener();
}

function NeedsRowBadges({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const badges = useSyncExternalStore(subscribe, () => current[workspaceId]);
  if (!badges || badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <WorkspaceRowBadge
          key={badge.kind}
          icon={ICON[badge.kind]}
          label={badge.label}
          tone={TONE[badge.kind]}
          accessibilityLabel={badge.description}
        />
      ))}
    </>
  );
}

export function startRowBadges(client: PluginClientContext): () => void {
  // Apps older than this API have no addWorkspaceRowBadgeItem (Paseo's reference says to check).
  if (typeof client.addWorkspaceRowBadgeItem !== "function") return () => undefined;
  const handle = client.subscribe(rowBadgesWatch, {}, (event) => publish(event.workspaces));
  const remove = client.addWorkspaceRowBadgeItem({
    id: "needs-you",
    title: "Mission Control: Needs you",
    icon: "Radar",
    Component: NeedsRowBadges,
  });
  return () => {
    remove();
    handle();
    publish({});
  };
}
