// src/tools/__test__/parser-test.ts
// 실행: npx tsx src/tools/__test__/parser-test.ts

// parseUseToolFormat, parseToolCallJsonFormat, parseToolCallLooseFormat을
// query.ts에서 export하거나, 여기에 복사해서 테스트한다.

const testCases = [
  // 1차: USE_TOOL 포맷
  {
    name: "USE_TOOL format",
    input: `Let me read that file for you.

USE_TOOL: FileRead
path: package.json
END_TOOL`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // USE_TOOL with multiple params
  {
    name: "USE_TOOL with range",
    input: `USE_TOOL: FileRead
path: src/index.ts
startLine: 1
endLine: 20
END_TOOL`,
    expected: {
      name: "FileRead",
      path: "src/index.ts",
      startLine: 1,
      endLine: 20,
    },
  },

  // 2차: JSON 포맷
  {
    name: "JSON format",
    input: `<tool_call>
{"name": "FileRead", "arguments": {"path": "package.json"}}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 중괄호 + 특수 따옴표
  {
    name: "Gemma variant - curly braces with special quotes",
    input: `<tool_call>
FileRead{path:<|"|>package.json<|"|>}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 괄호
  {
    name: "Gemma variant - parentheses",
    input: `<tool_call>
FileRead(path="package.json")
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 공백 구분
  {
    name: "Gemma variant - space separated",
    input: `<tool_call>
FileRead path=package.json
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - JSON 공백
  {
    name: "Gemma variant - name then JSON",
    input: `<tool_call>
FileRead {"path": "package.json"}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },
];

console.log("Parser Test Results:");
console.log("=".repeat(50));

// 여기에 파서 함수를 import하거나 복사하여 테스트
// 각 testCase.input을 parseToolCallsFromText()에 넣고
// 결과가 expected와 일치하는지 확인

for (const tc of testCases) {
  console.log(`\n📋 ${tc.name}`);
  console.log(
    `   Input: ${tc.input.substring(0, 60).replace(/\n/g, "\\n")}...`,
  );
  console.log(`   Expected: ${JSON.stringify(tc.expected)}`);
  // const result = parseToolCallsFromText(tc.input);
  // console.log(`   Got: ${JSON.stringify(result)}`);
  // console.log(`   ${result.length > 0 ? "✅ PASS" : "❌ FAIL"}`);
}
