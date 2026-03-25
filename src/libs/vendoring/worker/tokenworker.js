/*
This file contains a stripped down adaptation of the
tokenizer from Huggingface's Transformers.js.
Entirely LLM refactored, here be dragons.

Original transformers.js work:
Copyright The Hugging Face Inc. team.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { parentPort } from "node:worker_threads";

class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    const item = this.cache.get(key);
    if (item !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const keysToDelete = Math.max(1, Math.floor(this.maxSize * 0.1));
      const iterator = this.cache.keys();
      for (let i = 0; i < keysToDelete; i++) {
        this.cache.delete(iterator.next().value);
      }
    }
    this.cache.set(key, value);
  }
}

var MAX_CACHE_LENGTH = 256;
var _TEXT_ENCODER;

function getTextEncoder() {
  if (!_TEXT_ENCODER) {
    _TEXT_ENCODER = new TextEncoder();
  }
  return _TEXT_ENCODER;
}

var PROBLEMATIC_REPLACERS = [
  {
    re: /(?i:'s|'t|'re|'ve|'m|'ll|'d)/g,
    replacement:
      "(?:'s|'S|'t|'T|'re|'Re|'rE|'RE|'ve|'Ve|'vE|'VE|'m|'M|'ll|'Ll|'lL|'LL|'d|'D)",
  },
];

function createPattern(patternConfig, invert = true) {
  if (!patternConfig) {
    return null;
  }
  if (patternConfig.Regex !== undefined) {
    let regexStr = patternConfig.Regex;
    for (const { re, replacement } of PROBLEMATIC_REPLACERS) {
      regexStr = regexStr.replace(re, replacement);
    }
    regexStr = regexStr.replace(/\(([#&~])\)/g, "(?:$1)");
    return new RegExp(regexStr, "gu");
  }
  if (patternConfig.String !== undefined) {
    return new RegExp(RegExp.escape(patternConfig.String), invert ? "gu" : "g");
  }
  return null;
}

function regexSplit(text, regex) {
  if (!text) return [];
  if (!regex) return [text];

  const result = [];
  let lastIndex = 0;
  const re = regex.global ? regex : new RegExp(regex.source, regex.flags + "g");
  re.lastIndex = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    if (idx > lastIndex) {
      result.push(text.slice(lastIndex, idx));
    }
    const matchValue = m[0];
    if (matchValue === undefined) continue;

    if (m.length > 1) {
      for (let i = 1; i < m.length; i++) {
        const captureGroup = m[i];
        if (captureGroup !== undefined) {
          result.push(captureGroup);
        }
      }
    } else {
      result.push(matchValue);
    }
    lastIndex = idx + matchValue.length;
    if (re.lastIndex === idx) {
      re.lastIndex++;
    }
  }
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
}

var _BYTES_TO_UNICODE;
function getBytesToUnicode() {
  if (_BYTES_TO_UNICODE) {
    return _BYTES_TO_UNICODE;
  }
  const initialBytes = new Set([
    ...Array.from({ length: 126 - 33 + 1 }, (_, i) => i + 33),
    ...Array.from({ length: 172 - 161 + 1 }, (_, i) => i + 161),
    ...Array.from({ length: 255 - 174 + 1 }, (_, i) => i + 174),
  ]);
  const byteToChar = Array.from({ length: 256 }, () => "");
  let invisibleCharCodepoint = 256;
  for (let byte = 0; byte < 256; ++byte) {
    if (initialBytes.has(byte)) {
      byteToChar[byte] = String.fromCharCode(byte);
    } else {
      byteToChar[byte] = String.fromCharCode(invisibleCharCodepoint++);
    }
  }
  _BYTES_TO_UNICODE = byteToChar;
  return byteToChar;
}

function createNormalizer(config) {
  if (!config) {
    return (text) => text;
  }
  switch (config.type) {
    case "NFC":
      return (text) => text.normalize("NFC");
    case "Replace": {
      const pattern = createPattern(config.pattern);
      const { content } = config;
      return pattern
        ? (text) => String(text).replace(pattern, content)
        : (text) => text;
    }
    case "Sequence": {
      const normalizers = config.normalizers?.map(createNormalizer) ?? [];
      return (text) => normalizers.reduce((acc, norm) => norm(acc), text);
    }
    default:
      return (text) => text;
  }
}

function createPreTokenizer(config) {
  if (!config) {
    return (text) => (text ? [text] : []);
  }
  switch (config.type) {
    case "Sequence": {
      const preTokenizers = config.pretokenizers?.map(createPreTokenizer) ?? [];
      return (text) => {
        if (!text) return [];
        return preTokenizers.reduce(
          (segments, pt) => segments.flatMap((seg) => pt(seg)),
          [text],
        );
      };
    }
    case "Split": {
      const pattern = createPattern(config.pattern, config.invert);
      const behavior = config.behavior?.toLowerCase() ?? "";
      return (text) => {
        if (!text) return [];
        if (!pattern) return [text];
        if (config.invert) {
          return text.match(pattern) || [];
        }
        if (behavior === "removed") {
          return text.split(pattern).filter(Boolean);
        }
        return regexSplit(text, pattern);
      };
    }
    case "ByteLevel": {
      const { add_prefix_space = false, use_regex = true } = config;
      const pattern =
        /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
      const byteToChar = getBytesToUnicode();
      const textEncoder = getTextEncoder();

      return (text) => {
        if (text === null || text === undefined) return [];
        let processedText = String(text);
        if (add_prefix_space && !processedText.startsWith(" ")) {
          processedText = " " + processedText;
        }
        const rawTokens = use_regex
          ? processedText.match(pattern) || []
          : [processedText];

        return rawTokens.map((token) => {
          const bytes = textEncoder.encode(token);
          let str = "";
          for (let i = 0; i < bytes.length; i++) {
            str += byteToChar[bytes[i]];
          }
          return str;
        });
      };
    }
    case "Replace": {
      const pattern = createPattern(config.pattern);
      const { content } = config;
      return (text) =>
        text && pattern
          ? [String(text).replace(pattern, content)]
          : text
            ? [text]
            : [];
    }
    default:
      return (text) => (text ? [text] : []);
  }
}

function createBPEModel(modelConfig) {
  const vocab = new Map(Object.entries(modelConfig.vocab || {}));
  const unk_token_str = modelConfig.unk_token || null;
  const {
    byte_fallback = false,
    end_of_word_suffix,
    continuing_subword_suffix,
  } = modelConfig;

  const BYTE_AS_TOKEN_CACHE = Array.from({ length: 256 }, (_, i) => {
    return `<0x${i.toString(16).toUpperCase().padStart(2, "0")}>`;
  });

  const merges = new Map();
  for (const [i, merge_pair] of (modelConfig.merges || []).entries()) {
    let p1, p2;
    if (typeof merge_pair === "string") {
      const split_parts = merge_pair.split(" ");
      if (split_parts.length !== 2) continue;
      [p1, p2] = split_parts;
    } else if (Array.isArray(merge_pair) && merge_pair.length === 2) {
      [p1, p2] = merge_pair;
    } else {
      continue;
    }

    let p1Map = merges.get(p1);
    if (!p1Map) {
      p1Map = new Map();
      merges.set(p1, p1Map);
    }
    p1Map.set(p2, i);
  }

  const bpeCache = new LRUCache(5000);

  let maxN = 0;
  let prev, next, alive, ver, ord, heap;
  const HEAP_STRIDE = 6;

  function ensureCapacity(n) {
    if (n > maxN) {
      maxN = Math.max(n, maxN * 2, 256);
      prev = new Int32Array(maxN);
      next = new Int32Array(maxN);
      alive = new Uint8Array(maxN);
      ver = new Uint32Array(maxN);
      ord = new Int32Array(maxN);
      heap = new Int32Array(maxN * HEAP_STRIDE * 4);
    }
  }

  function bpe(token) {
    const cached = bpeCache.get(token);
    if (cached !== undefined) return cached;
    if (!token) return [];

    const parts = token.split("");
    if (end_of_word_suffix && parts.length > 0) {
      parts[parts.length - 1] = parts[parts.length - 1] + end_of_word_suffix;
    }

    const n = parts.length;
    if (n <= 1) {
      if (token.length < MAX_CACHE_LENGTH) {
        bpeCache.set(token, parts);
      }
      return parts;
    }

    ensureCapacity(n);

    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1;
      alive[i] = 1;
      ver[i] = 0;
      ord[i] = i;
    }
    next[n - 1] = -1;

    let heapSize = 0;

    const heapPush = (rank, ordVal, l, r, vL, vR) => {
      let idx = heapSize++;
      while (idx > 0) {
        const p = (idx - 1) >>> 1;
        const pPtr = p * HEAP_STRIDE;
        const idxPtr = idx * HEAP_STRIDE;

        const pRank = heap[pPtr];

        if (pRank < rank || (pRank === rank && heap[pPtr + 1] <= ordVal)) {
          break;
        }

        heap[idxPtr] = heap[pPtr];
        heap[idxPtr + 1] = heap[pPtr + 1];
        heap[idxPtr + 2] = heap[pPtr + 2];
        heap[idxPtr + 3] = heap[pPtr + 3];
        heap[idxPtr + 4] = heap[pPtr + 4];
        heap[idxPtr + 5] = heap[pPtr + 5];

        idx = p;
      }

      const fPtr = idx * HEAP_STRIDE;
      heap[fPtr] = rank;
      heap[fPtr + 1] = ordVal;
      heap[fPtr + 2] = l;
      heap[fPtr + 3] = r;
      heap[fPtr + 4] = vL;
      heap[fPtr + 5] = vR;
    };

    const heapPop = (outObj) => {
      if (heapSize === 0) return false;

      outObj.rank = heap[0];
      outObj.ord = heap[1];
      outObj.l = heap[2];
      outObj.r = heap[3];
      outObj.vL = heap[4];
      outObj.vR = heap[5];

      heapSize--;
      const lastIdx = heapSize;

      if (lastIdx > 0) {
        const lastPtr = lastIdx * HEAP_STRIDE;
        const lastRank = heap[lastPtr];
        const lastOrd = heap[lastPtr + 1];

        let idx = 0;
        const half = lastIdx >>> 1;

        while (idx < half) {
          let left = (idx << 1) + 1;
          let right = left + 1;
          let smallest = left;

          const leftPtr = left * HEAP_STRIDE;
          const rightPtr = right * HEAP_STRIDE;

          if (right < lastIdx) {
            const rRank = heap[rightPtr];
            const lRank = heap[leftPtr];
            if (
              rRank < lRank ||
              (rRank === lRank && heap[rightPtr + 1] < heap[leftPtr + 1])
            ) {
              smallest = right;
            }
          }

          const smallPtr = smallest * HEAP_STRIDE;
          const sRank = heap[smallPtr];

          if (
            lastRank < sRank ||
            (lastRank === sRank && lastOrd <= heap[smallPtr + 1])
          ) {
            break;
          }

          const idxPtr = idx * HEAP_STRIDE;
          heap[idxPtr] = heap[smallPtr];
          heap[idxPtr + 1] = heap[smallPtr + 1];
          heap[idxPtr + 2] = heap[smallPtr + 2];
          heap[idxPtr + 3] = heap[smallPtr + 3];
          heap[idxPtr + 4] = heap[smallPtr + 4];
          heap[idxPtr + 5] = heap[smallPtr + 5];

          idx = smallest;
        }

        const fPtr = idx * HEAP_STRIDE;
        heap[fPtr] = heap[lastPtr];
        heap[fPtr + 1] = heap[lastPtr + 1];
        heap[fPtr + 2] = heap[lastPtr + 2];
        heap[fPtr + 3] = heap[lastPtr + 3];
        heap[fPtr + 4] = heap[lastPtr + 4];
        heap[fPtr + 5] = heap[lastPtr + 5];
      }
      return true;
    };

    const getRank = (l, r) => {
      if (l === -1 || r === -1) return undefined;
      const p1Map = merges.get(parts[l]);
      if (p1Map) return p1Map.get(parts[r]);
      return undefined;
    };

    for (let i = 0; i < n - 1; i++) {
      const rk = getRank(i, i + 1);
      if (rk !== undefined) {
        heapPush(rk, ord[i], i, i + 1, ver[i], ver[i + 1]);
      }
    }

    const top = { rank: 0, ord: 0, l: 0, r: 0, vL: 0, vR: 0 };

    while (heapPop(top)) {
      const { l, r, vL, vR } = top;

      if (
        !alive[l] ||
        !alive[r] ||
        ver[l] !== vL ||
        ver[r] !== vR ||
        next[l] !== r ||
        prev[r] !== l
      ) {
        continue;
      }

      parts[l] = parts[l] + parts[r];
      alive[r] = 0;
      ver[l] = ver[l] + 1;

      const rn = next[r];
      next[l] = rn;
      if (rn !== -1) {
        prev[rn] = l;
      }

      if (ord[r] < ord[l]) {
        ord[l] = ord[r];
      }

      const pl = prev[l];
      if (pl !== -1) {
        const rk1 = getRank(pl, l);
        if (rk1 !== undefined) {
          heapPush(rk1, ord[pl], pl, l, ver[pl], ver[l]);
        }
      }

      if (rn !== -1) {
        const rk2 = getRank(l, rn);
        if (rk2 !== undefined) {
          heapPush(rk2, ord[l], l, rn, ver[l], ver[rn]);
        }
      }
    }

    const out = [];
    for (let i = 0; i !== -1; i = next[i]) {
      if (alive[i]) {
        out.push(parts[i]);
      }
    }

    if (continuing_subword_suffix && out.length > 1) {
      for (let i = 0; i < out.length - 1; i++) {
        out[i] = out[i] + continuing_subword_suffix;
      }
    }

    if (token.length < MAX_CACHE_LENGTH) {
      bpeCache.set(token, out);
    }
    return out;
  }

  function count(pre_tokenized_strings) {
    let token_count = 0;
    for (const token of pre_tokenized_strings) {
      if (!token) continue;
      const parts = bpe(token);
      for (const subword of parts) {
        if (vocab.has(subword)) {
          token_count++;
          continue;
        }
        if (byte_fallback) {
          const bytes = getTextEncoder().encode(subword);
          let all_bytes_in_vocab = true;
          for (const byte of bytes) {
            const byteToken = BYTE_AS_TOKEN_CACHE[byte];
            if (byteToken === undefined || !vocab.has(byteToken)) {
              all_bytes_in_vocab = false;
              break;
            }
          }
          if (all_bytes_in_vocab) {
            token_count += bytes.length;
            continue;
          }
        }
        token_count += unk_token_str ? 1 : subword.length;
      }
    }
    return token_count;
  }
  return { vocab, unk_token_str, count };
}

var getConfigToken = (configVal, fallback = null) =>
  typeof configVal === "string" ? configVal : (configVal?.content ?? fallback);

function buildAhoCorasick(patterns) {
  if (!patterns || patterns.length === 0) return null;
  const sortedPatterns = [...patterns].sort(
    (a, b) => b.content.length - a.content.length,
  );
  const root = { children: new Map(), output: null, failure: 0 };
  const trie = [root];

  for (const p of sortedPatterns) {
    let node = root;
    let nodeIndex;
    for (let i = 0; i < p.content.length; i++) {
      const charCode = p.content.charCodeAt(i);
      const childNodeIndex = node.children.get(charCode);
      if (childNodeIndex === undefined) {
        const newNodeIndex = trie.length;
        const newNode = { children: new Map(), output: null, failure: 0 };
        trie.push(newNode);
        node.children.set(charCode, newNodeIndex);
        node = newNode;
      } else {
        nodeIndex = childNodeIndex;
        node = trie[nodeIndex];
      }
    }
    if (!node.output) {
      node.output = p.content;
    }
  }

  const queue = [];
  for (const nodeIndex of root.children.values()) {
    queue.push(nodeIndex);
  }

  let qIndex = 0;
  while (qIndex < queue.length) {
    const currentIndex = queue[qIndex++];
    const currentNode = trie[currentIndex];

    for (const [charCode, childIndex] of currentNode.children.entries()) {
      let failureIndex = currentNode.failure;
      while (failureIndex > 0 && !trie[failureIndex].children.has(charCode)) {
        failureIndex = trie[failureIndex].failure;
      }

      const failureTargetNode = trie[failureIndex];
      if (failureTargetNode.children.has(charCode)) {
        trie[childIndex].failure = failureTargetNode.children.get(charCode);
      }

      const childNode = trie[childIndex];
      const failOutputNode = trie[childNode.failure];
      if (failOutputNode.output && !childNode.output) {
        childNode.output = failOutputNode.output;
      }
      queue.push(childIndex);
    }
  }
  return trie;
}

function createTokenizer(tokenizerJSON, tokenizerConfig) {
  const normalizer = createNormalizer(tokenizerJSON.normalizer);
  const pre_tokenizer = createPreTokenizer(tokenizerJSON.pre_tokenizer);
  const model =
    tokenizerJSON.model?.type === "BPE"
      ? createBPEModel(tokenizerJSON.model)
      : null;
  const added_tokens = tokenizerJSON.added_tokens || [];
  const addedTokensAho = buildAhoCorasick(added_tokens);
  const added_tokens_map = new Map(added_tokens.map((at) => [at.content, at]));

  const bos_token_str = getConfigToken(tokenizerConfig?.bos_token);
  const eos_token_str = getConfigToken(tokenizerConfig?.eos_token);
  const sep_token_str = getConfigToken(tokenizerConfig?.sep_token);

  let template_processor_config = null;
  const postProcessor = tokenizerJSON.post_processor;
  if (postProcessor) {
    if (postProcessor.type === "TemplateProcessing") {
      template_processor_config = postProcessor;
    } else if (postProcessor.type === "Sequence" && postProcessor.processors) {
      template_processor_config =
        postProcessor.processors.find(
          (p) => p?.type === "TemplateProcessing",
        ) ?? null;
    }
  }

  const countCoreCache = new LRUCache(5000);

  function count_text_core(text_input) {
    const cached = text_input ? countCoreCache.get(text_input) : undefined;
    if (cached !== undefined) return cached;
    if (text_input === null || text_input === undefined) return 0;

    const text = String(text_input);
    if (text === "") return 0;

    let total_count = 0;
    if (!addedTokensAho) {
      const norm = normalizer(text);
      const preTok = pre_tokenizer(norm);
      if (preTok?.length > 0) {
        total_count = model ? model.count(preTok) : preTok.length;
      }
    } else {
      let lastIndex = 0;
      let currentNodeIndex = 0;
      const trie = addedTokensAho;

      for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        let currentNode = trie[currentNodeIndex];
        let nextNodeIndex = currentNode.children.get(charCode);

        while (currentNodeIndex > 0 && nextNodeIndex === undefined) {
          currentNodeIndex = currentNode.failure;
          currentNode = trie[currentNodeIndex];
          nextNodeIndex = currentNode.children.get(charCode);
        }

        if (nextNodeIndex) {
          currentNodeIndex = nextNodeIndex;
        }

        const match = trie[currentNodeIndex].output;
        if (match) {
          const matchLen = match.length;
          const matchStart = i - matchLen + 1;

          if (matchStart > lastIndex) {
            const segment = text.slice(lastIndex, matchStart);
            const norm = normalizer(segment);
            const preTok = pre_tokenizer(norm);
            if (preTok?.length > 0) {
              total_count += model ? model.count(preTok) : preTok.length;
            }
          }
          total_count++;
          lastIndex = i + 1;
          currentNodeIndex = 0;
        }
      }

      if (lastIndex < text.length) {
        const segment = text.slice(lastIndex);
        const norm = normalizer(segment);
        const preTok = pre_tokenizer(norm);
        if (preTok?.length > 0) {
          total_count += model ? model.count(preTok) : preTok.length;
        }
      }
    }

    if (text_input.length < MAX_CACHE_LENGTH) {
      countCoreCache.set(text_input, total_count);
    }
    return total_count;
  }

  const isTokenValid = (token_str) =>
    added_tokens_map.has(token_str) || model?.vocab.has(token_str);

  function count(text, text_pair, add_special_tokens) {
    if (!model) return 0;

    const countA = count_text_core(text);
    const countB = text_pair ? count_text_core(text_pair) : 0;

    if (!add_special_tokens) {
      return countA + countB;
    }

    const template = text_pair
      ? template_processor_config?.pair
      : template_processor_config?.single;

    if (template) {
      return template.reduce((current_count, item) => {
        if (item.SpecialToken && isTokenValid(item.SpecialToken.id)) {
          return current_count + 1;
        }
        if (item.Sequence?.id === "A") {
          return current_count + countA;
        }
        if (item.Sequence?.id === "B" && text_pair) {
          return current_count + countB;
        }
        return current_count;
      }, 0);
    }

    let special_token_count = 0;
    if (bos_token_str && countA > 0 && isTokenValid(bos_token_str)) {
      special_token_count++;
    }
    if (text_pair) {
      if (sep_token_str && isTokenValid(sep_token_str)) {
        special_token_count++;
      }
    }
    if (eos_token_str && countA > 0 && isTokenValid(eos_token_str)) {
      special_token_count++;
    }
    return countA + countB + special_token_count;
  }

  return {
    count: (text, text_pair = null, options = {}) => {
      const { add_special_tokens = true } = options;
      return count(text, text_pair, add_special_tokens);
    },
  };
}

var tokenizerCache = new Map();

function loadTokenizer(
  tokenizerName,
  sharedTokenizerBuffer,
  sharedConfigBuffer,
) {
  if (!tokenizerCache.has(tokenizerName)) {
    const decoder = new TextDecoder();

    const tokenizerJSONStr = decoder.decode(
      new Uint8Array(sharedTokenizerBuffer),
    );
    const tokenizerJSON = JSON.parse(tokenizerJSONStr);

    const tokenizerConfigStr = decoder.decode(
      new Uint8Array(sharedConfigBuffer),
    );
    const tokenizerConfig = JSON.parse(tokenizerConfigStr);

    tokenizerCache.set(
      tokenizerName,
      createTokenizer(tokenizerJSON, tokenizerConfig),
    );
  }

  return tokenizerCache.get(tokenizerName);
}

if (parentPort) {
  parentPort.on("message", (data) => {
    const {
      type,
      jobId,
      tokenizerName,
      sharedTokenizerBuffer,
      sharedConfigBuffer,
      inputs,
    } = data;

    try {
      if (type === "init") {
        loadTokenizer(tokenizerName, sharedTokenizerBuffer, sharedConfigBuffer);

        parentPort.postMessage({
          type: "ready",
          memoryUsage: process.memoryUsage().rss,
        });
        return;
      }

      if (type === "count") {
        const tokenizer = loadTokenizer(
          tokenizerName,
          sharedTokenizerBuffer,
          sharedConfigBuffer,
        );
        const results = inputs.map((input) =>
          tokenizer.count(input.text, input.text_pair, input.options),
        );
        parentPort.postMessage({
          jobId,
          results,
          memoryUsage: process.memoryUsage().rss,
        });
        return;
      }
    } catch (e) {
      parentPort.postMessage({
        jobId,
        error: {
          message: e.message,
          stack: e.stack,
        },
      });
    }
  });
}

var tokenworker_default = {};
export { createTokenizer, tokenworker_default as default };
