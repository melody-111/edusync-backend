const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const API_URL = 'http://localhost:5001/api';
let token = '';

async function runTests() {
  console.log("=========================================");
  console.log("🛠  APP FEATURES TEST SUITE");
  console.log("=========================================\n");

  console.log("[1/4] Logging in...");
  try {
    const loginRes = await axios.post(`${API_URL}/auth/login-password`, {
      email: 'sudhanshusonkarsunsor@gmail.com',
      password: 'ssssss' // From your previous scripts
    });
    token = loginRes.data.token || loginRes.data.data.token;
    console.log("✅ Login successful! User:", loginRes.data.data?.user?.email || 'authenticated');
  } catch (err) {
    console.error("❌ Login failed:", err.response?.data || err.message);
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };

  console.log("\n[2/4] Testing Notes Flow (Save & Reopen)...");
  let noteId = '';
  const testCanvasData = "[{\"version\":\"7.2.0\",\"objects\":[{\"type\":\"circle\",\"left\":100,\"top\":100,\"radius\":50,\"fill\":\"red\"}]}]";
  try {
    const saveRes = await axios.post(`${API_URL}/files/note`, {
      title: 'AI Canvas Test Note',
      canvasData: testCanvasData
    }, { headers });
    const file = saveRes.data.data?.file || saveRes.data.file;
    noteId = file._id || file.id;
    console.log("✅ Note Saved to Cloud! ID:", noteId);

    const getRes = await axios.get(`${API_URL}/files/${noteId}`, { headers });
    const fetchedFile = getRes.data.data?.file || getRes.data.file;
    if (fetchedFile.canvasData === testCanvasData) {
      console.log("✅ Note Reopened Successfully! Canvas data matches exactly.");
    } else {
      console.log("⚠️ Note reopened, but data mismatch.");
    }
  } catch (err) {
    console.error("❌ Notes Flow failed:", err.response?.data || err.message);
  }

  console.log("\n[3/4] Testing YouTube Educational Search...");
  try {
    const ytRes = await axios.get(`${API_URL}/youtube/search?query=react+native`, { headers });
    const videos = ytRes.data.data?.videos || ytRes.data.videos;
    if (videos && videos.length > 0) {
      console.log(`✅ YouTube Search Success! Found ${videos.length} educational videos.`);
      console.log(`   First result: "${videos[0].title}" by ${videos[0].channelTitle}`);
    } else {
      console.log("⚠️ YouTube Search returned no results.");
    }
  } catch (err) {
    console.error("❌ YouTube Search failed:", err.response?.data || err.message);
  }

  console.log("\n[4/4] Testing AI ChatGPT Chat...");
  try {
    const aiRes = await axios.post(`${API_URL}/ai/chat`, {
      messages: [{ role: 'user', content: 'Hello AI' }]
    }, { headers });
    const message = aiRes.data.data?.message?.content || aiRes.data.message?.content;
    console.log("✅ AI Chat Success! Response received:");
    console.log(`   "${message}"`);
  } catch (err) {
    console.error("❌ AI Chat failed:", err.response?.data || err.message);
  }

  console.log("\n=========================================");
  console.log("🏁 ALL TESTS COMPLETED!");
  console.log("=========================================");
}

runTests();
