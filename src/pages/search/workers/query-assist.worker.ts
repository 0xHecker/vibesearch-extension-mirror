/// <reference lib="webworker" />
import { analyzeQuery } from "@src/search-core/query-language";
import type {
  AnalyzeQueryRequest,
  AnalyzeQueryResponse,
  AnalyzeQueryWorkerMessage,
  QueryAssistCatalogs,
} from "@src/search-core/contracts";

const EMPTY_CATALOGS: QueryAssistCatalogs = {
  sources: [],
  spaces: [],
  folders: [],
  tags: [],
  domains: [],
  authors: [],
  recentQueries: [],
};

let catalogs: QueryAssistCatalogs = EMPTY_CATALOGS;
let lastRequest: AnalyzeQueryRequest | null = null;

const runAnalysis = (request: AnalyzeQueryRequest) => {
  const analysis = analyzeQuery({
    ...request,
    catalogs,
  });
  const response: AnalyzeQueryResponse = {
    type: "ANALYZE_QUERY_RESULT",
    payload: analysis,
  };
  self.postMessage(response);
};

self.onmessage = (event: MessageEvent<AnalyzeQueryWorkerMessage>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === "SET_CATALOGS") {
    catalogs = message.catalogs || EMPTY_CATALOGS;
    // Catalogs changed (e.g. recent queries cleared): refresh suggestions for
    // the current input immediately instead of waiting for the next keystroke.
    if (lastRequest) runAnalysis(lastRequest);
    return;
  }

  if (message.type !== "ANALYZE_QUERY") return;

  lastRequest = message;
  runAnalysis(message);
};

export {};
