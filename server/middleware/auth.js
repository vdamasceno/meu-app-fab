// server/middleware/auth.js
const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
  // Pega o token do cabeçalho 'Authorization'
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'Acesso negado. Nenhum token fornecido.' });
  }

  // O token vem no formato "Bearer TOKEN_LONGO"
  // Pegamos apenas a parte do token
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token mal formatado.' });
  }

  try {
    // Verifica se o token é válido usando nossa chave secreta
    const decodedPayload = jwt.verify(token, process.env.JWT_SECRET);

    // Se for válido, anexa o payload (com id, nome, role) ao objeto da requisição
    req.user = decodedPayload;

    // Deixa a requisição continuar para a rota principal
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
};