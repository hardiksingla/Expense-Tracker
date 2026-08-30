require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEYS[0] });
async function test() {
    const geminiTools = [{
        functionDeclarations: [{
            name: "queryExpenses",
            description: "Queries past expenses",
            parameters: {
                type: "OBJECT",
                properties: {
                    startDate: { type: "STRING" },
                    endDate: { type: "STRING" }
                },
                required: ["startDate", "endDate"]
            }
        }]
    }];
    const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [{ role: "user", parts: [{ text: "give me the list of all my miscellaneous transactions this month" }] }],
        config: { tools: geminiTools }
    });
    console.log("Response Object keys:", Object.keys(response));
    console.log("functionCalls getter exists?", typeof response.functionCalls !== 'undefined');
    if (response.functionCalls) {
        console.log("length:", response.functionCalls.length);
        console.log("first item:", JSON.stringify(response.functionCalls[0]));
    }
    console.log("candidates?", !!response.candidates);
}
test().catch(console.error);
