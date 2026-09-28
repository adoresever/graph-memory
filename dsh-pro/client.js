window.__ModuleLoader__.load({
  id: "graph-memory-pro-dsh",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");

    function invalid(subject) {
      throw new TypeError(`graph-memory-pro: invalid ${subject}`);
    }

    function plain(value, subject) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(subject);
      return value;
    }

    function exact(value, keys, subject) {
      const record = plain(value, subject);
      for (const key of Object.keys(record)) if (!keys.includes(key)) invalid(`${subject}.${key}`);
      return record;
    }

    function string(value, subject) {
      if (typeof value !== "string") invalid(subject);
      return value;
    }

    function finite(value, subject) {
      if (typeof value !== "number" || !Number.isFinite(value)) invalid(subject);
      return value;
    }

    function boolean(value, subject) {
      if (typeof value !== "boolean") invalid(subject);
      return value;
    }

    function nodeType(value, subject) {
      const type = string(value, subject);
      if (type !== "TASK" && type !== "SKILL" && type !== "EVENT") invalid(subject);
      return type;
    }

    const requestSchema = {
      parse(value) {
        const source = exact(value, ["query", "nodeTypes", "maxNodes"], "snapshot request");
        const result = {};
        if (source.query !== undefined) result.query = string(source.query, "snapshot request.query");
        if (source.nodeTypes !== undefined) {
          if (!Array.isArray(source.nodeTypes)) invalid("snapshot request.nodeTypes");
          result.nodeTypes = source.nodeTypes.map((value, index) => nodeType(value, `snapshot request.nodeTypes[${index}]`));
        }
        if (source.maxNodes !== undefined) {
          const maxNodes = finite(source.maxNodes, "snapshot request.maxNodes");
          if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1000) invalid("snapshot request.maxNodes");
          result.maxNodes = maxNodes;
        }
        return result;
      },
    };

    function parseNode(value, subject, extraKeys = []) {
      const node = exact(value, [
        "id", "type", "name", "description", "status", "validatedCount",
        "sourceSessionCount", "communityId", "pagerank", "createdAt", "updatedAt",
        ...extraKeys,
      ], subject);
      const status = string(node.status, `${subject}.status`);
      if (status !== "active" && status !== "deprecated") invalid(`${subject}.status`);
      return {
        id: string(node.id, `${subject}.id`),
        type: nodeType(node.type, `${subject}.type`),
        name: string(node.name, `${subject}.name`),
        description: string(node.description, `${subject}.description`),
        status,
        validatedCount: finite(node.validatedCount, `${subject}.validatedCount`),
        sourceSessionCount: finite(node.sourceSessionCount, `${subject}.sourceSessionCount`),
        communityId: node.communityId === null ? null : string(node.communityId, `${subject}.communityId`),
        pagerank: finite(node.pagerank, `${subject}.pagerank`),
        createdAt: finite(node.createdAt, `${subject}.createdAt`),
        updatedAt: finite(node.updatedAt, `${subject}.updatedAt`),
      };
    }

    function parseEdge(value, subject) {
      const edge = exact(value, ["id", "fromId", "toId", "type", "instruction", "condition", "createdAt"], subject);
      const type = string(edge.type, `${subject}.type`);
      if (!["RELATES", "USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"].includes(type)) invalid(`${subject}.type`);
      const parsed = {
        id: string(edge.id, `${subject}.id`),
        fromId: string(edge.fromId, `${subject}.fromId`),
        toId: string(edge.toId, `${subject}.toId`),
        type,
        instruction: string(edge.instruction, `${subject}.instruction`),
        createdAt: finite(edge.createdAt, `${subject}.createdAt`),
      };
      if (edge.condition !== undefined) parsed.condition = string(edge.condition, `${subject}.condition`);
      return parsed;
    }

    const snapshotSchema = {
      parse(value) {
        const snapshot = exact(value, ["generatedAt", "nodes", "edges", "totals", "truncated"], "snapshot result");
        if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) invalid("snapshot result collections");
        const totals = exact(snapshot.totals, ["nodes", "edges"], "snapshot result.totals");
        const truncated = exact(snapshot.truncated, ["nodes", "edges"], "snapshot result.truncated");
        return {
          generatedAt: finite(snapshot.generatedAt, "snapshot result.generatedAt"),
          nodes: snapshot.nodes.map((node, index) => parseNode(node, `snapshot result.nodes[${index}]`)),
          edges: snapshot.edges.map((edge, index) => parseEdge(edge, `snapshot result.edges[${index}]`)),
          totals: {
            nodes: finite(totals.nodes, "snapshot result.totals.nodes"),
            edges: finite(totals.edges, "snapshot result.totals.edges"),
          },
          truncated: {
            nodes: boolean(truncated.nodes, "snapshot result.truncated.nodes"),
            edges: boolean(truncated.edges, "snapshot result.truncated.edges"),
          },
        };
      },
    };

    const detailRequestSchema = { parse: (value) => string(value, "node id") };
    const detailSchema = {
      parse(value) {
        if (value === null) return null;
        const detail = exact(value, [
          "id", "type", "name", "description", "status", "validatedCount",
          "sourceSessionCount", "communityId", "pagerank", "createdAt", "updatedAt",
          "content", "contentTruncated",
        ], "node detail");
        return {
          ...parseNode(detail, "node detail", ["content", "contentTruncated"]),
          content: string(detail.content, "node detail.content"),
          contentTruncated: boolean(detail.contentTruncated, "node detail.contentTruncated"),
        };
      },
    };

    const strict = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, schema });
    const remoteContribution = {
      package: "graph-memory-pro-dsh",
      descriptors: [
        {
          id: "graph-memory-pro-dsh#graphMemoryPro/snapshot",
          service: "graphMemoryPro",
          namespace: "graphMemoryPro",
          method: "snapshot",
          invocation: { kind: "direct" },
          parameters: [{
            name: "request",
            wire: "request",
            source: "json",
            codec: strict("graph-memory/pro#GraphSnapshotRequest", requestSchema),
          }],
          result: strict("graph-memory/pro#GraphSnapshot", snapshotSchema),
        },
        {
          id: "graph-memory-pro-dsh#graphMemoryPro/detail",
          service: "graphMemoryPro",
          namespace: "graphMemoryPro",
          method: "detail",
          invocation: { kind: "direct" },
          parameters: [{
            name: "id",
            wire: "id",
            source: "json",
            codec: strict("graph-memory/pro#GraphNodeId", detailRequestSchema),
          }],
          result: strict("graph-memory/pro#GraphNodeDetail|null", detailSchema),
        },
      ],
    };

    const colors = {
      TASK: "#4f8cff",
      SKILL: "#22b8a7",
      EVENT: "#a879ff",
    };

    function GraphMemoryPanel({ close, loadSnapshot }) {
      const [query, setQuery] = React.useState("");
      const [snapshot, setSnapshot] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState("");

      const refresh = React.useCallback(async (nextQuery) => {
        setLoading(true);
        setError("");
        try {
          setSnapshot(await loadSnapshot(nextQuery));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setLoading(false);
        }
      }, [loadSnapshot]);

      React.useEffect(() => { void refresh(""); }, [refresh]);

      const nodes = snapshot?.nodes ?? [];
      return React.createElement("div", {
        role: "dialog",
        "aria-modal": true,
        "aria-label": "Graph Memory Pro",
        style: {
          position: "fixed", inset: "24px", zIndex: 1000, display: "flex", flexDirection: "column",
          border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "18px",
          background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
          boxShadow: "0 24px 80px rgba(0,0,0,.28)", overflow: "hidden",
        },
      },
      React.createElement("header", {
        style: { display: "flex", alignItems: "center", gap: "12px", padding: "18px 20px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
      },
      React.createElement("div", { style: { flex: 1 } },
        React.createElement("strong", { style: { fontSize: "17px" } }, "Graph Memory Pro"),
        React.createElement("div", { style: { marginTop: "3px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" } }, "只读知识图谱 · SQLite GraphSnapshot")),
      React.createElement("input", {
        value: query,
        placeholder: "搜索任务、技能或事件",
        onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => { if (event.key === "Enter") void refresh(query); },
        style: { width: "260px", height: "34px", borderRadius: "9px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "inherit", padding: "0 12px" },
      }),
      React.createElement("button", { type: "button", onClick: () => { void refresh(query); }, style: buttonStyle }, "刷新"),
      React.createElement("button", { type: "button", onClick: close, "aria-label": "关闭", style: iconButtonStyle }, "×")),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "240px minmax(0,1fr)", minHeight: 0, flex: 1 } },
        React.createElement("aside", { style: { padding: "18px", borderRight: "1px solid var(--dsw-alias-border-l2)", overflow: "auto" } },
          React.createElement("div", { style: metricStyle }, React.createElement("span", null, "节点"), React.createElement("strong", null, snapshot?.totals.nodes ?? "—")),
          React.createElement("div", { style: metricStyle }, React.createElement("span", null, "关系"), React.createElement("strong", null, snapshot?.totals.edges ?? "—")),
          React.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: 1.7 } }, "当前为 Pro Lite 只读视图。数据由 DSH Host 通过受控 Remote 提供，浏览器不接触 SQLite 或 Neo4j 凭据。")),
        React.createElement("main", { style: { padding: "18px", overflow: "auto" } },
          loading ? React.createElement("p", null, "正在读取图谱…") : null,
          error ? React.createElement("p", { role: "alert", style: { color: "var(--dsw-alias-label-error)" } }, error) : null,
          !loading && !error && nodes.length === 0 ? React.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "暂无匹配的记忆节点。") : null,
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: "12px" } },
            ...nodes.map((node) => React.createElement("article", {
              key: node.id,
              style: { padding: "14px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", background: "var(--dsw-alias-bg-layer-3)" },
            },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
              React.createElement("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: colors[node.type] } }),
              React.createElement("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, node.type),
              React.createElement("small", { style: { marginLeft: "auto", color: "var(--dsw-alias-label-tertiary)" } }, `PR ${node.pagerank.toFixed(3)}`)),
            React.createElement("h3", { style: { margin: "10px 0 6px", fontSize: "14px" } }, node.name),
            React.createElement("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: 1.6 } }, node.description || "暂无描述")))))));
    }

    const buttonStyle = {
      height: "34px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "9px",
      background: "var(--dsw-alias-button-elevated-fill)", color: "inherit", cursor: "pointer", padding: "0 13px",
    };
    const iconButtonStyle = { ...buttonStyle, width: "34px", padding: 0, fontSize: "20px" };
    const metricStyle = { display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)" };

    function GraphMemoryEntry({ wide, loadSnapshot }) {
      const [open, setOpen] = React.useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          type: "button",
          title: "Graph Memory Pro",
          "aria-label": "打开 Graph Memory Pro",
          onClick: () => setOpen(true),
          style: {
            width: wide ? "100%" : "36px", height: "36px", display: "flex", alignItems: "center",
            justifyContent: wide ? "flex-start" : "center", gap: "9px", padding: wide ? "0 10px" : 0,
            border: 0, borderRadius: "9px", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer",
          },
        }, React.createElement("span", { "aria-hidden": true, style: { fontSize: "17px" } }, "◎"), wide ? React.createElement("span", null, "Graph Memory") : null),
        open ? React.createElement(GraphMemoryPanel, { close: () => setOpen(false), loadSnapshot }) : null);
    }

    const inject = ["slots", "remote"];
    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(remoteContribution);
      const disposeSlot = ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "graph-memory-pro",
        order: -10,
        inject: () => ({
          loadSnapshot: async (query) => {
            const result = await ctx.remote.graphMemoryPro.snapshot({ query, maxNodes: 120 });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
          },
        }),
      }, GraphMemoryEntry));
      return async () => {
        disposeSlot();
        await disposeRemote();
      };
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
