const axios = require('axios');
const API_URL = 'https://edusync-backend-application.onrender.com';
let token = '';
let noteId = '';

async function runTest() {
  console.log("1. Logging in...");
  const loginRes = await axios.post(`${API_URL}/auth/login-password`, {
    email: 'sudhanshusonkarsunsor@gmail.com',
    password: 'ssssss'
  });
  token = loginRes.data.data.accessToken;

  const headers = { Authorization: `Bearer ${token}` };

  console.log("2. Creating a blank note...");
  const blankCanvas = "[{\"version\":\"7.2.0\",\"objects\":[]}]";
  const saveRes = await axios.post(`${API_URL}/files/note`, {
    title: 'Blank Test Note 2',
    canvasData: blankCanvas
  }, { headers });
  const file = saveRes.data.file || saveRes.data.data?.file || saveRes.data.data;
  noteId = file._id || file.id;
  console.log("Save successful! Note ID:", noteId, "Cloud URL:", file.cloudUrl);

  console.log("3. Fetching the created note...");
  const getRes = await axios.get(`${API_URL}/files/${noteId}`, { headers });
  const fetchedFile = getRes.data.file || getRes.data.data?.file || getRes.data.data;
  console.log("Fetch successful! Canvas data length:", fetchedFile.canvasData?.length || 0, "Cloud URL:", fetchedFile.cloudUrl);
}
runTest();
