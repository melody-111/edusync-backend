const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const API_URL = 'http://localhost:5001/api';
let token = '';
let noteId = '';

async function runTest() {
  console.log("1. Logging in...");
  try {
    const loginRes = await axios.post(`${API_URL}/auth/login`, {
      email: 'sudhanshusonkarsunsor@gmail.com',
      password: 'ssssss'
    });
    token = loginRes.data.token;
    console.log("Login successful! Token:", token.substring(0, 20) + "...");
  } catch (err) {
    console.error("Login failed:", err.response?.data || err.message);
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };

  console.log("2. Creating a blank note...");
  const blankCanvas = "[{\"version\":\"7.2.0\",\"objects\":[]}]";
  try {
    const saveRes = await axios.post(`${API_URL}/files/note`, {
      title: 'Blank Test Note',
      canvasData: blankCanvas
    }, { headers });
    const file = saveRes.data.file || saveRes.data.data.file;
    noteId = file._id || file.id;
    console.log("Save successful! Note ID:", noteId);
  } catch (err) {
    console.error("Save failed:", err.response?.data || err.message);
    return;
  }

  console.log("3. Fetching the created note...");
  try {
    const getRes = await axios.get(`${API_URL}/files/${noteId}`, { headers });
    const file = getRes.data.file || getRes.data.data.file;
    console.log("Fetch successful! Canvas data length:", file.canvasData?.length || 0);
  } catch (err) {
    console.error("Fetch failed:", err.response?.data || err.message);
  }
}
runTest();
