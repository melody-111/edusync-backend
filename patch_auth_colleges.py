import re

with open('src/controllers/authController.js', 'r') as f:
    content = f.read()

search_code = """
/**
 * GET /auth/colleges/search?q=XYZ
 * Public endpoint to search for existing colleges by name
 */
const searchCollegesPublic = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return sendSuccess(res, []);
  
  const safeSearchKey = q.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  const colleges = await College.find({ name: new RegExp(safeSearchKey, 'i') })
    .limit(10)
    .select('name collegeCode institutionType');
    
  sendSuccess(res, colleges);
});
"""

if 'searchCollegesPublic' not in content:
    content = content.replace('const searchTeacher = asyncHandler', search_code + '\nconst searchTeacher = asyncHandler')
    content = content.replace('module.exports = {', 'module.exports = {\n  searchCollegesPublic,')

with open('src/controllers/authController.js', 'w') as f:
    f.write(content)
