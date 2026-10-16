import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginHost } from "@/types/canvas-plugin";

const ignore = () => {};
const rejectGeneration = async () => { throw new Error("只读查看不能触发生成"); };

// 插件只能取得快照副本，不能通过引用或宿主能力修改正在受控的画布。
export function createCanvasObserverHost(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasPluginHost {
    const neighbors = (nodeId: string, upstream: boolean) => structuredClone(connections
        .filter((edge) => (upstream ? edge.toNodeId : edge.fromNodeId) === nodeId)
        .map((edge) => nodes.find((node) => node.id === (upstream ? edge.fromNodeId : edge.toNodeId)))
        .filter((node): node is CanvasNodeData => Boolean(node)));
    return {
        readOnly: true,
        getNode: (id) => structuredClone(nodes.find((node) => node.id === id) || null),
        getNodes: () => structuredClone(nodes),
        getConnections: () => structuredClone(connections),
        getUpstream: (id) => neighbors(id, true),
        getDownstream: (id) => neighbors(id, false),
        updateNode: ignore, updateMetadata: ignore, applyOps: ignore,
        openPanel: ignore, closePanel: ignore,
        ai: { generateImage: rejectGeneration, generateVideo: rejectGeneration, generateText: rejectGeneration, listModels: () => [], defaultModel: () => "" },
    };
}
