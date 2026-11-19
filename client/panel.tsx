import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { archiverScanNow, archiverSetConfig, archiverStatus } from "../shared/contract";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ArchiverPanel({ theme, layout }: PluginSurfaceProps) {
  const fetchStatus = useRpc(archiverStatus);
  const runScan = useRpc(archiverScanNow);
  const saveConfig = useRpc(archiverSetConfig);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["archiver", "status"],
    queryFn: () => fetchStatus({}),
    refetchInterval: 30_000,
  });
  const scan = useMutation({
    mutationFn: () => runScan({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["archiver"] }),
  });
  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => saveConfig(p as never),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["archiver"] }),
  });

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, padding: layout.compact ? 12 : 16, gap: 10, backgroundColor: theme.colors.surface0 },
        title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "700" },
        subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
        tileRow: { flexDirection: "row", gap: 8 },
        tile: { flex: 1, padding: 12, borderRadius: 10, gap: 2, backgroundColor: theme.colors.surface1 },
        tileValue: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "700" },
        tileLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
        button: { padding: 12, borderRadius: 10, alignItems: "center", backgroundColor: theme.colors.accent },
        buttonMuted: { backgroundColor: theme.colors.surface1 },
        buttonText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" },
        buttonTextMuted: { color: theme.colors.foreground },
        chip: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
        chipActive: { backgroundColor: theme.colors.accent },
        chipText: { color: theme.colors.foreground, fontSize: 13 },
        chipTextActive: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
        sectionTitle: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
        row: {
          flexDirection: "row",
          justifyContent: "space-between",
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.surface1,
        },
        text: { color: theme.colors.foreground, fontSize: 13 },
        textMuted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 8 },
        warn: { color: theme.colors.statusDanger },
        ok: { color: theme.colors.statusSuccess },
        badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: theme.colors.surface1 },
        badgeText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      }),
    [theme, layout.compact],
  );

  if (query.isLoading) {
    return (
      <View style={styles.screen}>
        <Text style={styles.subtitle}>加载中…</Text>
      </View>
    );
  }
  if (query.isError || !query.data) {
    return (
      <View style={styles.screen}>
        <Text style={styles.warn}>状态读取失败，稍后自动重试</Text>
      </View>
    );
  }

  const s = query.data;
  const c = s.config;
  const modeLabel = !c.enabled ? "已停用" : c.dryRun ? "预览（不动手）" : "自动归档中";

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Session Archiver</Text>
      <Text style={styles.subtitle}>
        {modeLabel} · idle&gt;{c.idleDays} 天 · 每 {c.intervalMin} 分钟 · 上次扫描 {fmtTime(s.lastSweepAt)}
      </Text>

      <View style={styles.tileRow}>
        <View style={styles.tile}>
          <Text style={styles.tileValue}>{s.scanned}</Text>
          <Text style={styles.tileLabel}>扫描总数</Text>
        </View>
        <View style={styles.tile}>
          <Text style={[styles.tileValue, s.candidates > 0 ? styles.warn : styles.ok]}>{s.candidates}</Text>
          <Text style={styles.tileLabel}>归档候选</Text>
        </View>
        <View style={styles.tile}>
          <Text style={styles.tileValue}>{s.totalArchived}</Text>
          <Text style={styles.tileLabel}>累计归档</Text>
        </View>
      </View>

      <Pressable accessibilityRole="button" onPress={() => scan.mutate()} style={styles.button}>
        <Text style={styles.buttonText}>{scan.isPending ? "扫描中…" : "立即扫描"}</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>归档阈值（idle 超过多少天）</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {[7, 14, 30, 60, 90].map((n) => {
          const active = c.idleDays === n;
          return (
            <Pressable
              key={n}
              accessibilityRole="button"
              accessibilityLabel={`阈值 ${n} 天`}
              onPress={() => { if (!active) patch.mutate({ idleDays: n }); }}
              style={[styles.chip, active ? styles.chipActive : styles.buttonMuted]}
            >
              <Text style={active ? styles.chipTextActive : styles.chipText}>{n}天</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => patch.mutate({ dryRun: !c.dryRun })}
          style={[styles.button, styles.buttonMuted, { flex: 1 }]}
        >
          <Text style={[styles.buttonText, styles.buttonTextMuted]}>
            {c.dryRun ? "开启自动归档" : "切回预览模式"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => patch.mutate({ enabled: !c.enabled })}
          style={[styles.button, styles.buttonMuted, { flex: 1 }]}
        >
          <Text style={[styles.buttonText, styles.buttonTextMuted]}>{c.enabled ? "停用插件" : "启用插件"}</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>候选名单（idle&gt;{c.idleDays} 天，前 50）</Text>
      <ScrollView style={{ flex: 1 }}>
        {s.rows.length === 0 ? (
          <Text style={styles.empty}>没有候选 —— 一切正常</Text>
        ) : (
          s.rows.map((r) => (
            <View key={r.id} style={styles.row}>
              <Text style={styles.text} numberOfLines={1}>
                {r.title || r.id.slice(0, 8)}
              </Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{r.status}</Text>
                </View>
                <Text style={styles.textMuted}>{r.days}天</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Text style={styles.sectionTitle}>最近扫描（{s.history.length}）</Text>
      <ScrollView style={{ maxHeight: 120 }}>
        {s.history.map((h) => (
          <View key={h.at} style={styles.row}>
            <Text style={styles.textMuted}>{fmtTime(h.at)}</Text>
            <Text style={styles.textMuted}>{h.mode === "plan" ? "预览" : "执行"}</Text>
            <Text style={styles.textMuted}>
              候选 {h.candidates} · 归档 {h.archived}
              {h.ok < h.archived ? ` · 失败 ${h.archived - h.ok}` : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
