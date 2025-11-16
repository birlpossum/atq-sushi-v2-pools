// Policy Reference: Kleros ATQ Registry Guidelines Version 2.3.0
//
// This module retrieves Sushiswap v2 liquidity pool data from The Graph's decentralized network
// and transforms it into contract tags for the Kleros Address Tag Registry (ATQ).
// It queries Messari's standardized Sushiswap subgraphs to get liquidity pool information,
// then generates tags for the LP tokens (outputToken) with standardized naming conventions.
//
import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";

// 2025-11-15: Sushi does not publish official subgraph deployment IDs in their documentation.
// Per policy, we fall back to using Messari's standardized Sushiswap subgraphs.
// Sushi v2 Liquidity Pools on supported chains using Messari subgraphs
// Messari Sushiswap subgraphs: https://thegraph.com/explorer?search=messari%20sushiswap
const SUBGRAPH_URLS: Record<string, string> = {
  "56": "https://gateway.thegraph.com/api/[api-key]/deployments/id/QmPi9QJjaPfoTEwfNMiuqoZmTc1RGFi3DeZy4UERDDqSJn",
  "137": "https://gateway.thegraph.com/api/[api-key]/deployments/id/Qmc3gbKAd1eemQbaTvY93S2FpuPEipGaVKCQ97pBkXgtyN",
  "250": "https://gateway.thegraph.com/api/[api-key]/deployments/id/QmZ3Zs57Bt9njPji3Ty6A9761hwQaHYYGMCjs5f7oiidxz",
  "1285": "https://gateway.thegraph.com/api/[api-key]/deployments/id/QmZw2kXL8tt6FoNeo4qLSN3rbe9tkWtGxDtBV3iWJMEkf7",
};

// ---------- Types ----------
interface LiquidityPool {
  id: string;                    // pool contract address
  name: string;                  // pool name
  symbol?: string | null;        // pool symbol/ticker
  inputTokens?: Array<{          // tokens in the pool
    id: string;
    symbol: string;
    name: string;
  }> | null;
  outputToken?: {                // LP token
    id: string;
    symbol: string;
    name: string;
  } | null;
}

interface GraphQLData {
  liquidityPools: LiquidityPool[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[];
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

// ---------- Block pinning ----------
const GET_META_BLOCK_QUERY = `
  query { _meta { block { number } } }
`;

async function fetchIndexedBlockNumber(subgraphUrl: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(subgraphUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: GET_META_BLOCK_QUERY }),
      signal: controller.signal,
    } as any);
    if (!resp.ok) throw new Error(`HTTP error (meta): ${resp.status}`);
    const json: any = await resp.json();
    const blockNumber = json?.data?._meta?.block?.number;
    if (typeof blockNumber !== "number") {
      throw new Error("Failed to read _meta.block.number from subgraph response");
    }
    return blockNumber;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Request timed out while querying _meta for block number.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- Pools query ----------
// Policy note: Using 'id' field with id_gt for cursor-based pagination as a unique fallback
// since Messari subgraphs may not expose a single-field unique+sequential cursor.
const GET_POOLS_QUERY = `
  query GetPools($lastId: ID, $block: Int!) {
    liquidityPools(
      first: 1000
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
      block: { number: $block }
    ) {
      id
      name
      symbol
      inputTokens {
        id
        symbol
        name
      }
      outputToken {
        id
        symbol
        name
      }
    }
  }
`;

async function fetchPools(
  subgraphUrl: string,
  lastId: string,
  blockNumber: number
): Promise<LiquidityPool[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: any;
  try {
    response = await fetch(subgraphUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: GET_POOLS_QUERY,
        variables: { lastId, block: blockNumber },
      }),
      signal: controller.signal,
    } as any);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Request timed out while querying the pools subgraph.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`HTTP error (pools): ${response.status}`);
  const result = (await response.json()) as GraphQLResponse;
  if (result.errors) {
    result.errors.forEach((error) =>
      console.error(`GraphQL error (pools): ${error.message}`)
    );
    throw new Error("GraphQL error from pools subgraph.");
  }
  return result.data?.liquidityPools ?? [];
}

// ---------- Transform to Kleros-friendly tags ----------
function truncateString(text: string, maxLength: number): string {
  return text.length > maxLength
    ? text.substring(0, maxLength - 3) + "..."
    : text;
}

function transformPoolsToTags(
  chainId: string,
  pools: LiquidityPool[]
): ContractTag[] {
  const tags: ContractTag[] = [];
  const seen = new Set<string>();

  for (const pool of pools) {
    // Tag the LP token (outputToken), not the pool contract itself
    const lpToken = pool.outputToken;
    if (!lpToken?.id || seen.has(lpToken.id)) continue;
    seen.add(lpToken.id);

    const lpSymbol = lpToken.symbol?.trim() ?? "";
    const lpName = lpToken.name?.trim() ?? "";

    // Skip if symbol is missing or invalid
    if (!lpSymbol || lpSymbol === "") continue;

    // Match reference format: "${symbol} Pool" with 45 char max
    const maxLen = 45;
    const publicNameTag = truncateString(`${lpSymbol} Pool`, maxLen);

    // Match reference format: "Sushi's ${symbol} (${name}) pool contract."
    const publicNote = `Sushi's ${lpSymbol} (${lpName}) pool contract.`;

    tags.push({
      "Contract Address": `eip155:${chainId}:${lpToken.id}`,
      "Public Name Tag": publicNameTag,
      "Project Name": "Sushi",
      "UI/Website Link": "https://www.sushi.com/",
      "Public Note": publicNote,
    });
  }
  return tags;
}

// ---------- Main service ----------
class TagService implements ITagService {
  returnTags = async (chainId: string, apiKey: string): Promise<ContractTag[]> => {
    const originalChainId = chainId;
    const trimmedChainId = (chainId ?? "").trim();

    // Enforce decimal string format only
    if (!/^\d+$/.test(trimmedChainId)) {
      throw new Error(
        `Unsupported Chain ID: ${originalChainId}. Only 56 (BNB Chain), 137 (Polygon), 250 (Fantom), and 1285 (Moonriver) are currently supported in this module.`
      );
    }

    const chainIdNum = Number(trimmedChainId);
    const supportedChains = [56, 137, 250, 1285];

    if (!Number.isInteger(chainIdNum) || !supportedChains.includes(chainIdNum)) {
      throw new Error(
        `Unsupported Chain ID: ${originalChainId}. Only 56 (BNB Chain), 137 (Polygon), 250 (Fantom), and 1285 (Moonriver) are currently supported in this module.`
      );
    }

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error("Missing API key. A The Graph gateway API key is required.");
    }

    const chainKey = String(chainIdNum);
    const subgraphUrl = SUBGRAPH_URLS[chainKey]?.replace(
      "[api-key]",
      encodeURIComponent(apiKey)
    );

    if (!subgraphUrl || subgraphUrl.includes("PLACEHOLDER")) {
      throw new Error(
        `Subgraph URL not configured for Chain ID: ${originalChainId}. Please provide the official Messari Sushiswap subgraph URL.`
      );
    }

    // Pin to a consistent snapshot
    const blockNumber = await fetchIndexedBlockNumber(subgraphUrl);

    // Page pools with id_gt cursor
    let lastId = "0x0000000000000000000000000000000000000000";
    let prevLastId = "";
    const allPools: LiquidityPool[] = [];
    let isMore = true;

    while (isMore) {
      const page = await fetchPools(subgraphUrl, lastId, blockNumber);
      allPools.push(...page);

      isMore = page.length === 1000;
      if (isMore) {
        const nextLastId = page[page.length - 1].id;
        if (!nextLastId || nextLastId === lastId || nextLastId === prevLastId) {
          throw new Error(
            "Pagination cursor (pools) did not advance; aborting."
          );
        }
        prevLastId = lastId;
        lastId = nextLastId;
      }
    }

    // Build tags
    return transformPoolsToTags(String(chainIdNum), allPools);
  };
}

const tagService = new TagService();
export const returnTags = tagService.returnTags;
