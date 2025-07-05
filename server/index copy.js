const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const authMiddleware = require('./middleware/auth'); // Importa o nosso "segurança"

const app = express();
const port = 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// --- ROTAS DA API ---

// Rota de teste
app.get('/', (req, res) => {
  res.send('Servidor do SIA-QME está no ar!');
});

// Rota para buscar todas as queixas - VERSÃO ATUALIZADA COM DATA
app.get('/api/complaints', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  const { search, location } = req.query;

  let baseQuery = `
    SELECT 
      complaints.id,
      complaints.location,
      complaints.intensity,
      users.name AS pilot_name,
      complaints.submission_date -- ★★★ NOVA LINHA ADICIONADA AQUI ★★★
    FROM 
      complaints
    JOIN 
      users ON complaints.pilot_user_id = users.id
  `;

  const whereClauses = [];
  const values = [];
  let paramIndex = 1;

  if (search) {
    whereClauses.push(`users.name ILIKE $${paramIndex}`);
    values.push(`%${search}%`);
    paramIndex++;
  }

  if (location) {
    whereClauses.push(`complaints.location = $${paramIndex}`);
    values.push(location);
    paramIndex++;
  }

  if (whereClauses.length > 0) {
    baseQuery += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  baseQuery += ` ORDER BY complaints.id DESC;`;

  try {
    const result = await db.query(baseQuery, values);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Erro ao buscar queixas:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar os dados das queixas.' });
  }
});

/**
 * ROTA PARA BUSCAR OS DETALHES COMPLETOS DE UMA QUEIXA (VERSÃO 3.0 com IMC)
 * Junta dados da queixa, do piloto (com IMC), do IPAQ e do NASA-TLX.
 */
app.get('/api/complaint-details/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  const { id } = req.params;

  try {
    const query = `
      SELECT
        c.*,
        u.name as pilot_name,
        u.email as pilot_email,
        pp.rank,
        pp.saram,
        pp.whatsapp,
        pp.birth_date,
        pp.aircraft_type,
        pp.weight_kg, -- ★★★ CAMPO ADICIONADO À BUSCA ★★★
        pp.height_m,  -- ★★★ CAMPO ADICIONADO À BUSCA ★★★
        ipaq.vigorous_activity_days,
        ipaq.vigorous_activity_minutes,
        ipaq.moderate_activity_days,
        ipaq.moderate_activity_minutes,
        ipaq.walking_days,
        ipaq.walking_minutes,
        nasa.overall_score as nasa_tlx_score,
        nasa.mental_demand_rating,
        nasa.physical_demand_rating,
        nasa.temporal_demand_rating,
        nasa.performance_rating,
        nasa.effort_rating,
        nasa.frustration_rating
      FROM
        complaints c
      JOIN
        users u ON c.pilot_user_id = u.id
      LEFT JOIN
        pilot_profiles pp ON c.pilot_user_id = pp.user_id
      LEFT JOIN
        ipaq_assessments ipaq ON c.id = ipaq.complaint_id
      LEFT JOIN
        nasa_tlx_assessments nasa ON c.id = nasa.complaint_id
      WHERE
        c.id = $1;
    `;
    
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Queixa não encontrada.' });
    }

    const rawData = result.rows[0];

    // Lógica de classificação do IPAQ (inalterada)
    let ipaqClassification = 'Não informado';
    if (rawData.moderate_activity_days !== null) {
      const vigorousMET = 8.0 * (rawData.vigorous_activity_days || 0) * (rawData.vigorous_activity_minutes || 0);
      const moderateMET = 4.0 * (rawData.moderate_activity_days || 0) * (rawData.moderate_activity_minutes || 0);
      const walkingMET = 3.3 * (rawData.walking_days || 0) * (rawData.walking_minutes || 0);
      const totalMET = vigorousMET + moderateMET + walkingMET;
      const totalDays = (rawData.vigorous_activity_days || 0) + (rawData.moderate_activity_days || 0) + (rawData.walking_days || 0);
      if ((rawData.vigorous_activity_days >= 3 && totalMET >= 1500) || totalDays >= 7 && totalMET >= 3000) {
        ipaqClassification = 'Muito Ativo';
      } else if ((rawData.vigorous_activity_days >= 3) || (rawData.moderate_activity_days >= 5) || (totalDays >= 5 && (vigorousMET + moderateMET) >= 600)) {
        ipaqClassification = 'Ativo';
      } else {
        ipaqClassification = 'Insuficientemente Ativo';
      }
    }

    // ★★★ NOVA LÓGICA PARA CÁLCULO DE IMC ★★★
    let bmi = null;
    let bmiClassification = 'Dados insuficientes';
    // Usamos os campos do banco de dados, como `weight_kg` e `height_m`
    if (rawData.weight_kg && rawData.height_m && rawData.height_m > 0) {
        const weight = parseFloat(rawData.weight_kg);
        const height = parseFloat(rawData.height_m);
        bmi = parseFloat((weight / (height * height)).toFixed(2));

        if (bmi < 18.5) bmiClassification = 'Abaixo do peso';
        else if (bmi < 25) bmiClassification = 'Peso Normal';
        else if (bmi < 30) bmiClassification = 'Sobrepeso';
        else if (bmi < 35) bmiClassification = 'Obesidade Grau I';
        else if (bmi < 40) bmiClassification = 'Obesidade Grau II';
        else bmiClassification = 'Obesidade Grau III';
    }

    // Prepara a resposta final para o frontend
    const responsePayload = {
      complaint: {
        id: rawData.id,
        location: rawData.location,
        submission_date: rawData.submission_date,
        intensity: rawData.intensity, // ★★★ CORREÇÃO AQUI: era rawDara ★★★
        onset: rawData.onset,
        history: rawData.history,
        loss_of_movement: rawData.loss_of_movement,
        used_medication: rawData.used_medication
      },
      pilot: {
        name: rawData.pilot_name,
        email: rawData.pilot_email,
        rank: rawData.rank,
        saram: rawData.saram,
        whatsapp: rawData.whatsapp,
        birth_date: rawData.birth_date,
        aircraft_type: rawData.aircraft_type,
        weight: rawData.weight_kg,
        height: rawData.height_m,
        bmi: bmi,
        bmiClassification: bmiClassification
      },
      ipaq: {
        classification: ipaqClassification,
      },
      nasa_tlx: {
        overall_score: rawData.nasa_tlx_score,
        ratings: {
          mental: rawData.mental_demand_rating,
          physical: rawData.physical_demand_rating,
          temporal: rawData.temporal_demand_rating,
          performance: rawData.performance_rating,
          effort: rawData.effort_rating,
          frustration: rawData.frustration_rating
        }
      }
    };
    
    res.status(200).json(responsePayload);

  } catch (error) {
    console.error(`Erro ao buscar detalhes completos da queixa ${id}:`, error);
    res.status(500).json({ error: 'Erro no servidor ao buscar detalhes da queixa.' });
  }
});

/**
 * ROTA PARA BUSCAR OS DETALHES COMPLETOS DE UMA QUEIXA (VERSÃO 3.0 com IFL)
 */
app.get('/api/complaint-details/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  const { id } = req.params;

  try {
    const query = `
      SELECT
        c.*, u.name as pilot_name, u.email as pilot_email, pp.rank, pp.saram,
        pp.whatsapp, pp.birth_date, pp.aircraft_type, pp.weight_kg, pp.height_m,
        ipaq.vigorous_activity_days, ipaq.vigorous_activity_minutes,
        ipaq.moderate_activity_days, ipaq.moderate_activity_minutes,
        ipaq.walking_days, ipaq.walking_minutes, nasa.overall_score as nasa_tlx_score
      FROM complaints c
      JOIN users u ON c.pilot_user_id = u.id
      LEFT JOIN pilot_profiles pp ON c.pilot_user_id = pp.user_id
      LEFT JOIN ipaq_assessments ipaq ON c.id = ipaq.complaint_id
      LEFT JOIN nasa_tlx_assessments nasa ON c.id = nasa.complaint_id
      WHERE c.id = $1;
    `;
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Queixa não encontrada.' });

    const rawData = result.rows[0];

    // Lógicas de IPAQ e IMC (inalteradas)
    let ipaqClassification = 'Não informado'; // ... (lógica do ipaq)
    let bmi = null, bmiClassification = 'Dados insuficientes'; // ... (lógica do imc)
    // (Omiti o código completo do IPAQ e IMC aqui para ser mais breve, mas ele continua o mesmo)

    // ★★★ NOVA LÓGICA PARA O ÍNDICE DE FADIGA LESIONAL (IFL) ★★★
    
    // 1. Função para atribuir o peso com base na localização
    const getLocationWeight = (location) => {
      const weight3 = ['Tórax', 'Coluna Torácica', 'Coluna Lombar', 'Pelve e Nádegas', 'Quadril e virilha'];
      const weight2 = ['Cabeça', 'Ombro', 'Joelho', 'Coxa'];
      const weight1 = ['Punho e Mão', 'Antebraço', 'Perna, Tornozelo e Pé', 'Cotovelo'];

      if (weight3.includes(location)) return 3;
      if (weight2.includes(location)) return 2;
      if (weight1.includes(location)) return 1;
      return 0; // Retorna 0 se a localização não for encontrada, para não quebrar o cálculo
    };

    // 2. Cálculo do IFL
    let fatigueInjuryIndex = null;
    if (rawData.intensity && rawData.nasa_tlx_score) {
      const intensity = parseFloat(rawData.intensity);
      const nasaTlx = parseFloat(rawData.nasa_tlx_score);
      const locationWeight = getLocationWeight(rawData.location);
      
      fatigueInjuryIndex = parseFloat((intensity * nasaTlx * locationWeight).toFixed(2));
    }
    
    // ★★★ FIM DA NOVA LÓGICA ★★★

    // Prepara a resposta final para o frontend, agora com o IFL
    const responsePayload = {
      // ... (objetos complaint, pilot, ipaq, nasa_tlx inalterados) ...
      complaint: { id: rawData.id, location: rawData.location, /* ... outros campos ... */ },
      pilot: { name: rawData.pilot_name, /* ... outros campos ... */ },
      ipaq: { classification: ipaqClassification },
      nasa_tlx: { overall_score: rawData.nasa_tlx_score, /* ... outros campos ... */ },

      // ★★★ NOVO CAMPO ADICIONADO À RESPOSTA ★★★
      fatigueInjuryIndex: fatigueInjuryIndex
    };
    
    res.status(200).json(responsePayload);

  } catch (error) {
    console.error(`Erro ao buscar detalhes completos da queixa ${id}:`, error);
    res.status(500).json({ error: 'Erro no servidor ao buscar detalhes da queixa.' });
  }
});

// ROTA PARA BUSCAR O PERFIL DO USUÁRIO LOGADO
app.get('/api/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  
  try {
    let profileQuery;
    // A query agora depende do perfil do usuário
    if (userRole === 'PILOT') {
      profileQuery = `
        SELECT u.name, u.email, u.role, pp.* FROM users u
        LEFT JOIN pilot_profiles pp ON u.id = pp.user_id
        WHERE u.id = $1;
      `;
    } else if (userRole === 'HEALTH_PROFESSIONAL') {
      profileQuery = `
        SELECT u.name, u.email, u.role, hpp.* FROM users u
        LEFT JOIN health_professional_profiles hpp ON u.id = hpp.user_id
        WHERE u.id = $1;
      `;
    } else {
      // Para outros perfis (se houver no futuro)
      profileQuery = 'SELECT name, email, role FROM users WHERE id = $1';
    }

    const result = await db.query(profileQuery, [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil não encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro no servidor ao buscar perfil.' });
  }
});

// ROTA PARA ATUALIZAR O PERFIL (VERSÃO 3.0)
app.put('/api/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let result;
    if (userRole === 'PILOT') {
      const { rank, organization, aircraft_type, weight_kg, height_m, birth_date, saram, whatsapp, base_id } = req.body;
      const query = `
        UPDATE pilot_profiles
        SET rank = $1, organization = $2, aircraft_type = $3, weight_kg = $4, height_m = $5, birth_date = $6, saram = $7, whatsapp = $8, base_id = $9, updated_at = NOW()
        WHERE user_id = $10
        RETURNING *;
      `;
      const values = [rank, organization, aircraft_type, weight_kg, height_m, birth_date, saram, whatsapp, base_id, userId];
      result = await db.query(query, values);

    } else if (userRole === 'HEALTH_PROFESSIONAL') {
      const { crm_crefito, whatsapp, base_id } = req.body;
      const query = `
        UPDATE health_professional_profiles
        SET crm_crefito = $1, whatsapp = $2, base_id = $3, updated_at = NOW()
        WHERE user_id = $4
        RETURNING *;
      `;
       const values = [crm_crefito, whatsapp, base_id, userId];
      result = await db.query(query, values);
    } else {
      return res.status(400).json({ error: 'Tipo de perfil inválido para atualização.' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ error: 'Erro no servidor ao atualizar perfil.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA QUEIXA (VERSÃO 3.0 com DEBUG de Notificação)
 */
app.post('/api/complaints', authMiddleware, async (req, res) => {
  const pilot_user_id = req.user.id;
  const pilot_name = req.user.name;
  const { 
    step2_location, 
    step3_details, 
    step4_history
  } = req.body;

  if (!step2_location || !step2_location.location) {
    return res.status(400).json({ error: 'A localização da queixa é um campo obrigatório.' });
  }

  const impactMapping = { 'sem_impacto': 0, 'impacto_leve': 1, 'impacto_moderado': 2, 'incapaz_voar': 3 };
  const flightImpactAsNumber = impactMapping[step3_details?.flightImpact] || 0;

  const insertQuery = `
    INSERT INTO complaints (
      pilot_user_id, location, intensity, flight_performance_impact, 
      loss_of_movement, used_medication, onset, history
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *; 
  `;
  
  const values = [
    pilot_user_id, step2_location.location, step3_details?.intensity,
    flightImpactAsNumber, step3_details?.lossOfMovement ? 'Sim' : 'Não',
    step3_details?.used_medication ? 'Sim' : 'Não', step4_history?.onset,
    step4_history?.history
  ];

  try {
    const result = await db.query(insertQuery, values);
    const newComplaint = result.rows[0];

    // --- LÓGICA DE ROTEAMENTO E NOTIFICAÇÃO com DEBUG ---
    console.log(`\n[DEBUG] Queixa #${newComplaint.id} salva. Iniciando lógica de notificação para piloto ID: ${pilot_user_id}`);
    const pilotProfileResult = await db.query('SELECT base_id FROM pilot_profiles WHERE user_id = $1', [pilot_user_id]);
    
    console.log('[DEBUG] Resultado da busca pelo perfil do piloto:', pilotProfileResult.rows);
    if (pilotProfileResult.rows.length > 0) {
      const pilotBaseId = pilotProfileResult.rows[0].base_id;
      console.log(`[DEBUG] Base ID do piloto é: ${pilotBaseId}`);

      if (pilotBaseId) {
        console.log(`[DEBUG] Buscando profissionais na base ID: ${pilotBaseId}...`);
        const healthProfessionalsResult = await db.query(
          `SELECT hpp.user_id FROM health_professional_profiles hpp WHERE hpp.base_id = $1`,
          [pilotBaseId]
        );
        console.log(`[DEBUG] Profissionais encontrados na base:`, healthProfessionalsResult.rows);
        
        const professionalsToNotify = healthProfessionalsResult.rows;
        
        if (professionalsToNotify.length > 0) {
          console.log(`[DEBUG] Loop de notificação iniciado para ${professionalsToNotify.length} profissional(is).`);
          const notificationMessage = `O piloto ${pilot_name} registrou uma nova queixa de ${newComplaint.location}.`;
          const notificationLink = `/complaint/${newComplaint.id}`;

          for (const prof of professionalsToNotify) {
            console.log(`[DEBUG] Inserindo notificação para user_id: ${prof.user_id}`);
            await db.query(
              'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)',
              [prof.user_id, notificationMessage, notificationLink]
            );
          }
          console.log('[DEBUG] Loop de notificação finalizado.');
        } else {
            console.log('[DEBUG] Lógica de notificação parada: nenhum profissional encontrado para esta base.');
        }
      } else {
        console.log('[DEBUG] Lógica de notificação parada: a base do piloto é nula.');
      }
    } else {
        console.log('[DEBUG] Lógica de notificação parada: perfil do piloto não encontrado.');
    }
    // --- FIM DA LÓGICA ---

    res.status(201).json(newComplaint);

  } catch (error) {
    console.error('Erro detalhado ao salvar queixa:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao salvar a queixa no banco de dados.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA AVALIAÇÃO DO IPAQ (VERSÃO 2.0)
 * Agora ela recebe e salva o ID da queixa associada.
 */
app.post('/api/assessments/ipaq', authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;

  if (role !== 'PILOT') {
    return res.status(403).json({ error: 'Apenas pilotos podem registrar uma avaliação IPAQ.' });
  }

  // ★★★ MUDANÇA AQUI: Pegamos o complaint_id do corpo da requisição
  const {
    complaint_id, // <-- NOVO CAMPO
    vigorous_activity_days,
    vigorous_activity_minutes,
    moderate_activity_days,
    moderate_activity_minutes,
    walking_days,
    walking_minutes,
    sitting_minutes
  } = req.body;

  // Validação para garantir que o ID da queixa foi enviado
  if (!complaint_id) {
    return res.status(400).json({ error: 'O ID da queixa é obrigatório para salvar a avaliação IPAQ.' });
  }

  // ★★★ MUDANÇA AQUI: Adicionamos a nova coluna na query
  const insertQuery = `
    INSERT INTO ipaq_assessments (
      user_id, complaint_id, vigorous_activity_days, vigorous_activity_minutes, 
      moderate_activity_days, moderate_activity_minutes, walking_days, 
      walking_minutes, sitting_minutes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id;
  `;

  // ★★★ MUDANÇA AQUI: Adicionamos o novo valor na lista
  const values = [
    userId,
    complaint_id, // <-- NOVO VALOR
    vigorous_activity_days,
    vigorous_activity_minutes,
    moderate_activity_days,
    moderate_activity_minutes,
    walking_days,
    walking_minutes,
    sitting_minutes
  ];

  try {
    const result = await db.query(insertQuery, values);
    return res.status(201).json({ 
      message: 'Avaliação IPAQ salva com sucesso!', 
      assessmentId: result.rows[0].id 
    });
  } catch (error) {
    console.error('Erro ao salvar avaliação IPAQ:', error);
    return res.status(500).json({ error: 'Ocorreu um erro ao salvar a avaliação.' });
  }
});

// ================================================================================================
// ESTA É A VERSÃO FINAL COM O NOME CORRETO DA COLUNA DE DATA
// ================================================================================================
app.get('/api/complaints/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }

  const { id } = req.params;

  try {
    const complaintQuery = `
      SELECT 
        c.*, 
        u.name AS pilot_name, u.email,
        pp.weight_kg, 
        pp.height_m
      FROM complaints c
      JOIN users u ON c.pilot_user_id = u.id
      LEFT JOIN pilot_profiles pp ON u.id = pp.user_id
      WHERE c.id = $1;
    `;
    const complaintResult = await db.query(complaintQuery, [id]);

    if (complaintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Queixa não encontrada.' });
    }
    const complaintData = complaintResult.rows[0];
    const pilotId = complaintData.pilot_user_id;

    // ================================================================
    // CORREÇÃO FINAL: Usando o nome da coluna que encontramos ('assessment_date')
    // ================================================================
    const ipaqResult = await db.query('SELECT * FROM ipaq_assessments WHERE user_id = $1 ORDER BY assessment_date DESC LIMIT 1', [pilotId]);
    const nasaTlxResult = await db.query('SELECT * FROM nasa_tlx_assessments WHERE user_id = $1 ORDER BY assessment_date DESC LIMIT 1', [pilotId]);
    
    const ipaqData = ipaqResult.rows[0];
    const nasaTlxData = nasaTlxResult.rows[0];

    // --- Lógica de Negócio (já corrigida anteriormente) ---
    let imc = null;
    if (complaintData.weight_kg && complaintData.height_m) {
      const heightInMeters = parseFloat(complaintData.height_m);
      if (heightInMeters > 0) {
        imc = (parseFloat(complaintData.weight_kg) / (heightInMeters * heightInMeters)).toFixed(2);
      }
    }
    
    let isActive = false;
    let totalMinutes = 0;
    if (ipaqData) {
      const vigorousMinutes = (ipaqData.vigorous_activity_days || 0) * (ipaqData.vigorous_activity_minutes || 0);
      const moderateMinutes = (ipaqData.moderate_activity_days || 0) * (ipaqData.moderate_activity_minutes || 0);
      totalMinutes = vigorousMinutes + moderateMinutes;
      isActive = totalMinutes > 300;
    }
    
    const responsePayload = {
      complaint: complaintData,
      pilotProfile: {
        weight: complaintData.weight_kg,
        height: complaintData.height_m,
        imc: imc,
      },
      activityLevel: {
        isActive: isActive,
        totalMinutes: totalMinutes,
        details: ipaqData,
      },
      nasaTlx: nasaTlxData,
    };

    res.status(200).json(responsePayload);

  } catch (error) {
    console.error(`Erro ao buscar detalhes da queixa ${id}:`, error);
    res.status(500).json({ error: 'Erro no servidor ao buscar detalhes da queixa.' });
  }
});

/**
 * ROTA PARA SALVAR UMA NOVA AVALIAÇÃO DO NASA-TLX (VERSÃO 2.0)
 * Agora ela recebe e salva o ID da queixa associada.
 */
app.post('/api/assessments/nasa-tlx', authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;

  if (role !== 'PILOT') {
    return res.status(403).json({ error: 'Apenas pilotos podem registrar uma avaliação NASA-TLX.' });
  }

  // ★★★ MUDANÇA AQUI: Pegamos o complaint_id e os outros dados
  const {
    complaint_id, // <-- NOVO CAMPO
    mental_demand_rating, physical_demand_rating, temporal_demand_rating,
    performance_rating, effort_rating, frustration_rating,
    mental_demand_weight, physical_demand_weight, temporal_demand_weight,
    performance_weight, effort_weight, frustration_weight,
    overall_score
  } = req.body;

  // Validação
  if (!complaint_id) {
    return res.status(400).json({ error: 'O ID da queixa é obrigatório para salvar a avaliação NASA-TLX.' });
  }

  // ★★★ MUDANÇA AQUI: Adicionamos a nova coluna na query
  const insertQuery = `
    INSERT INTO nasa_tlx_assessments (
      user_id, complaint_id, mental_demand_rating, physical_demand_rating, temporal_demand_rating,
      performance_rating, effort_rating, frustration_rating,
      mental_demand_weight, physical_demand_weight, temporal_demand_weight,
      performance_weight, effort_weight, frustration_weight, overall_score
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id;
  `;

  // ★★★ MUDANÇA AQUI: Adicionamos o novo valor na lista
  const values = [
    userId, complaint_id, mental_demand_rating, physical_demand_rating, temporal_demand_rating,
    performance_rating, effort_rating, frustration_rating,
    mental_demand_weight, physical_demand_weight, temporal_demand_weight,
    performance_weight, effort_weight, frustration_weight, overall_score
  ];

  try {
    const result = await db.query(insertQuery, values);
    return res.status(201).json({
      message: 'Avaliação NASA-TLX salva com sucesso!',
      assessmentId: result.rows[0].id
    });
  } catch (error) {
    console.error('Erro ao salvar avaliação NASA-TLX:', error);
    return res.status(500).json({ error: 'Ocorreu um erro ao salvar a avaliação NASA-TLX.' });
  }
});

// ROTA PARA UM PILOTO BUSCAR OS DETALHES DE UMA QUEIXA E SEU PARECER (VERSÃO 2.0 com IPAQ e NASA-TLX)
app.get('/api/my-complaints/:id', authMiddleware, async (req, res) => {
    const { id: complaintId } = req.params;
    const pilotUserId = req.user.id;

    if (req.user.role !== 'PILOT') {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    try {
        // ★★★ MUDANÇA AQUI: Adicionamos LEFT JOINs para buscar dados do IPAQ e NASA-TLX ★★★
        const query = `
            SELECT 
                c.id, c.location, c.intensity, c.submission_date, c.onset, c.history,
                ha.diagnosis, ha.treatment_plan, ha.notes AS assessment_notes, ha.assessment_date, ha.id AS assessment_id,
                prof.name AS professional_name,
                ipaq.vigorous_activity_days, ipaq.vigorous_activity_minutes,
                ipaq.moderate_activity_days, ipaq.moderate_activity_minutes,
                ipaq.walking_days, ipaq.walking_minutes,
                nasa.overall_score AS nasa_tlx_score
            FROM complaints c
            LEFT JOIN health_assessments ha ON c.id = ha.complaint_id
            LEFT JOIN users prof ON ha.assessing_professional_id = prof.id
            LEFT JOIN ipaq_assessments ipaq ON c.id = ipaq.complaint_id
            LEFT JOIN nasa_tlx_assessments nasa ON c.id = nasa.complaint_id
            WHERE c.id = $1 AND c.pilot_user_id = $2;
        `;
        
        const result = await db.query(query, [complaintId, pilotUserId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Queixa não encontrada ou acesso não permitido.' });
        }
        
        const rawData = result.rows[0];

        // Se houver um parecer, marcamos como lido
        if (rawData.assessment_id) {
            await db.query('UPDATE health_assessments SET pilot_has_seen = TRUE WHERE id = $1', [rawData.assessment_id]);
        }

        // ★★★ LÓGICA DE NEGÓCIO: Calculando a classificação do IPAQ no backend ★★★
        let ipaqClassification = 'Não informado';
        if (rawData.moderate_activity_days !== null) { // Verifica se há dados do IPAQ
            const vigorousMET = 8.0 * (rawData.vigorous_activity_days || 0) * (rawData.vigorous_activity_minutes || 0);
            const moderateMET = 4.0 * (rawData.moderate_activity_days || 0) * (rawData.moderate_activity_minutes || 0);
            const walkingMET = 3.3 * (rawData.walking_days || 0) * (rawData.walking_minutes || 0);
            const totalMET = vigorousMET + moderateMET + walkingMET;
            const totalDays = (rawData.vigorous_activity_days || 0) + (rawData.moderate_activity_days || 0) + (rawData.walking_days || 0);
            if ((rawData.vigorous_activity_days >= 3 && totalMET >= 1500) || totalDays >= 7 && totalMET >= 3000) {
                ipaqClassification = 'Muito Ativo';
            } else if ((rawData.vigorous_activity_days >= 3) || (rawData.moderate_activity_days >= 5) || (totalDays >= 5 && (vigorousMET + moderateMET) >= 600)) {
                ipaqClassification = 'Ativo';
            } else {
                ipaqClassification = 'Insuficientemente Ativo';
            }
        }

        // ★★★ MUDANÇA AQUI: Montando o objeto de resposta completo ★★★
        const responsePayload = {
            complaint: {
                id: rawData.id,
                location: rawData.location,
                submission_date: rawData.submission_date,
                intensity: rawData.intensity,
                onset: rawData.onset,
                history: rawData.history,
            },
            assessment: rawData.assessment_id ? {
                diagnosis: rawData.diagnosis,
                treatment_plan: rawData.treatment_plan,
                notes: rawData.assessment_notes,
                assessment_date: rawData.assessment_date,
                professional_name: rawData.professional_name,
            } : null,
            ipaq: {
                classification: ipaqClassification
            },
            nasa_tlx: {
                overall_score: rawData.nasa_tlx_score
            }
        };

        res.status(200).json(responsePayload);

    } catch (error) {
        console.error(`Erro ao buscar detalhes da queixa ${complaintId} para o piloto ${pilotUserId}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ROTA PARA CONTAR NOTIFICAÇÕES NÃO LIDAS DE UM PILOTO
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
    const pilotUserId = req.user.id;

    if (req.user.role !== 'PILOT') {
        // Não é um erro, apenas retorna 0 para outros perfis
        return res.status(200).json({ unreadCount: 0 });
    }

    try {
        const countQuery = `
            SELECT COUNT(*)
            FROM health_assessments ha
            JOIN complaints c ON ha.complaint_id = c.id
            WHERE c.pilot_user_id = $1 AND ha.pilot_has_seen = FALSE;
        `;
        const result = await db.query(countQuery, [pilotUserId]);
        
        // O resultado de COUNT(*) é uma string, então convertemos para número
        const unreadCount = parseInt(result.rows[0].count, 10);

        res.status(200).json({ unreadCount });

    } catch (error) {
        console.error(`Erro ao contar notificações para o piloto ${pilotUserId}:`, error);
        res.status(500).json({ error: 'Erro ao buscar contagem de notificações.' });
    }
});

/**
 * ROTA PARA BUSCAR A LISTA DE BASES AÉREAS
 * Retorna todas as bases cadastradas para serem usadas em menus de seleção.
 */
app.get('/api/bases', authMiddleware, async (req, res) => {
  try {
    const query = 'SELECT id, name FROM air_force_bases ORDER BY name ASC;';
    const result = await db.query(query);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar bases aéreas:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar a lista de bases.' });
  }
});

// ROTA PARA UM PILOTO BUSCAR SEUS PRÓPRIOS PARECERES DE SAÚDE
app.get('/api/my-assessments', authMiddleware, async (req, res) => {
  const pilotId = req.user.id; // Pega o ID do piloto logado a partir do token

  // Garante que apenas usuários com o perfil de piloto possam acessar
  if (req.user.role !== 'PILOT') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const query = `
      SELECT 
        ha.id,
        ha.diagnosis,
        ha.treatment_plan,
        ha.notes,
        ha.assessment_date,
        c.location AS complaint_location,
        c.submission_date AS complaint_date,
        u.name AS professional_name
      FROM 
        health_assessments ha
      JOIN 
        complaints c ON ha.complaint_id = c.id
      JOIN
        users u ON ha.assessing_professional_id = u.id
      WHERE 
        c.pilot_user_id = $1
      ORDER BY 
        ha.assessment_date DESC;
    `;
    
    const result = await db.query(query, [pilotId]);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error(`Erro ao buscar pareceres para o piloto ${pilotId}:`, error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar seus pareceres.' });
  }
});

// ROTA PARA UM PILOTO BUSCAR SUAS PRÓPRIAS QUEIXAS
app.get('/api/my-complaints', authMiddleware, async (req, res) => {
    // Pega o ID do piloto logado a partir do token (que o authMiddleware já verificou)
    const pilotUserId = req.user.id; 

    // Garante que o usuário tem a permissão de 'PILOT'
    if (req.user.role !== 'PILOT') {
        return res.status(403).json({ error: 'Acesso negado. Apenas pilotos podem ver suas queixas.' });
    }

    try {
        const query = `
            SELECT 
                c.id,
                c.location as main_complaint, -- Usando 'location' como o nome principal da queixa na lista
                c.submission_date,
                -- A consulta abaixo verifica se já existe um parecer na tabela health_assessments
                CASE 
                    WHEN EXISTS (SELECT 1 FROM health_assessments ha WHERE ha.complaint_id = c.id)
                    THEN 'Parecer Disponível'
                    ELSE 'Aguardando Avaliação'
                END as assessment_status
            FROM 
                complaints c
            WHERE 
                c.pilot_user_id = $1
            ORDER BY 
                c.submission_date DESC;
        `;
        
        const { rows } = await db.query(query, [pilotUserId]);
        
        res.status(200).json(rows);

    } catch (error) {
        console.error('Erro ao buscar queixas do piloto:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar as queixas.' });
    }
});

// ==========================================================
// ROTA COMPLETA E CORRIGIDA PARA O PAINEL DE RELATÓRIOS
// ==========================================================
app.get('/api/reports/summary', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL' && req.user.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Acesso não autorizado.' });
  }
  try {
    const queries = [
      db.query(`SELECT COUNT(*) FROM users WHERE role = 'PILOT'`),
      db.query(`SELECT COUNT(*) FROM complaints`),
      db.query(`SELECT COALESCE(AVG(intensity), 0) as avg_intensity FROM complaints`),
      db.query(`SELECT location, COUNT(*) as count FROM complaints GROUP BY location`),
      db.query(`SELECT flight_performance_impact, COUNT(*) as count FROM complaints GROUP BY flight_performance_impact`),
      db.query(`SELECT TO_CHAR(submission_date, 'YYYY-MM') as month, COUNT(*) as count FROM complaints GROUP BY month ORDER BY month`),
      db.query(`SELECT loss_of_movement, COUNT(*) as count FROM complaints GROUP BY loss_of_movement`),
      db.query(`SELECT used_medication, COUNT(*) as count FROM complaints GROUP BY used_medication`),
      db.query(`SELECT onset, COUNT(*) as count FROM complaints GROUP BY onset`)
    ];
    const results = await Promise.all(queries);
    const [pilotsResult, complaintsResult, intensityResult, regionResult, impactResult, monthResult, lossOfMovementResult, medicationUseResult, onsetResult] = results;
    
    const impactMapping = { 0: 'Sem Impacto', 1: 'Impacto Leve', 2: 'Impacto Moderado', 3: 'Incapaz de Voar' };
    const formatForChart = (rows, keyField, valueField) => rows.reduce((acc, row) => ({ ...acc, [row[keyField]]: parseInt(row[valueField], 10) }), {});
    
    const summaryData = {
      totalPilots: parseInt(pilotsResult.rows[0].count, 10),
      totalComplaints: parseInt(complaintsResult.rows[0].count, 10),
      averageIntensity: parseFloat(intensityResult.rows[0].avg_intensity).toFixed(1),
      complaintsByRegion: formatForChart(regionResult.rows, 'location', 'count'),
      flightImpactDistribution: impactResult.rows.reduce((acc, row) => ({ ...acc, [impactMapping[row.flight_performance_impact] || 'Desconhecido']: parseInt(row.count, 10) }), {}),
      complaintsPerMonth: formatForChart(monthResult.rows, 'month', 'count'),
      lossOfMovement: formatForChart(lossOfMovementResult.rows, 'loss_of_movement', 'count'),
      medicationUse: formatForChart(medicationUseResult.rows, 'used_medication', 'count'),
      onsetDistribution: formatForChart(onsetResult.rows, 'onset', 'count')
    };
    res.json(summaryData);
  } catch (err) {
    console.error('Erro ao gerar o sumário de relatórios:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});


// ... (o resto das suas rotas de autenticação) ...

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});

/**
 * ROTA PARA BUSCAR AS NOTIFICAÇÕES DO USUÁRIO LOGADO
 */
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    // Busca todas as notificações do usuário, as mais novas primeiro
    const notificationsQuery = `
      SELECT id, message, link, is_read, created_at 
      FROM notifications 
      WHERE user_id = $1 
      ORDER BY created_at DESC;
    `;
    const notificationsResult = await db.query(notificationsQuery, [userId]);

    // Conta quantas delas ainda não foram lidas
    const unreadCountQuery = `
      SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE;
    `;
    const unreadCountResult = await db.query(unreadCountQuery, [userId]);

    res.status(200).json({
      notifications: notificationsResult.rows,
      unreadCount: parseInt(unreadCountResult.rows[0].count, 10)
    });
  } catch (error) {
    console.error('Erro ao buscar notificações:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar suas notificações.' });
  }
});

/**
 * ROTA PARA MARCAR UMA NOTIFICAÇÃO COMO LIDA
 */
app.post('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { id: notificationId } = req.params;

  try {
    const result = await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [notificationId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notificação não encontrada ou não pertence a este usuário.' });
    }

    res.status(200).json({ message: 'Notificação marcada como lida.' });
  } catch (error) {
    console.error('Erro ao marcar notificação como lida:', error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

// Rotas de Autenticação
// ROTA PARA REGISTRAR UM NOVO USUÁRIO (VERSÃO 3.0 - AGORA TAMBÉM FAZ O LOGIN)
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, passwordHash, role]
    );
    const newUser = newUserResult.rows[0];
    
    // Cria o perfil em branco correspondente ao tipo de usuário
    if (newUser.role === 'PILOT') {
        await db.query('INSERT INTO pilot_profiles (user_id) VALUES ($1)', [newUser.id]);
    } else if (newUser.role === 'HEALTH_PROFESSIONAL') {
        await db.query('INSERT INTO health_professional_profiles (user_id) VALUES ($1)', [newUser.id]);
    }

    // ★★★ NOVA LÓGICA ADICIONADA AQUI ★★★
    // Após criar o usuário, também geramos um token para ele já sair logado.
    const payload = {
        id: newUser.id,
        name: newUser.name,
        role: newUser.role
    };
    const token = jwt.sign(
        payload,
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
    );

    // Retornamos o usuário e o token, assim como na tela de login
    return res.status(201).json({ user: newUser, token });

  } catch (error) {
    console.error('Erro no registro:', error);
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

// Substitua a sua rota de login por esta versão com "espiões"
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    try {
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        const user = userResult.rows[0];

        const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordCorrect) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const payload = {
            id: user.id,
            name: user.name,
            role: user.role
        };
        const token = jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // A correção é adicionar o "return" aqui
        return res.status(200).json({ token, user: payload });

    } catch (error) {
        console.error('Erro no login:', error);
        // Também adicionamos um "return" aqui por segurança
        return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
    }
});

// ROTA PARA REGISTRAR UM NOVO USUÁRIO - VERSÃO CORRIGIDA
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    // Adiciona 'return'
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      // Adiciona 'return'
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, passwordHash, role]
    );
    const newUser = newUserResult.rows[0];
    
    if (newUser.role === 'PILOT') {
        await db.query('INSERT INTO pilot_profiles (user_id) VALUES ($1)', [newUser.id]);
    }

    // Adiciona 'return'
    return res.status(201).json(newUser);

  } catch (error) {
    console.error('Erro no registro:', error);
    // Adiciona 'return'
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

// Inicia o Servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});

/**
 * ROTA PARA SALVAR UMA NOVA ANÁLISE DO PROFISSIONAL DE SAÚDE (VERSÃO 3.0 com Notificação para o Piloto)
 */
app.post('/api/assessments', authMiddleware, async (req, res) => {
  if (req.user.role !== 'HEALTH_PROFESSIONAL') {
    return res.status(403).json({ error: 'Acesso negado. Apenas profissionais de saúde podem adicionar análises.' });
  }

  const { complaint_id, diagnosis, treatment_plan, notes } = req.body;
  const assessing_professional_id = req.user.id;

  if (!complaint_id || !diagnosis || !treatment_plan) {
    return res.status(400).json({ error: 'ID da Queixa, Diagnóstico e Plano de Tratamento são obrigatórios.' });
  }

  const insertQuery = `
    INSERT INTO health_assessments 
      (complaint_id, assessing_professional_id, diagnosis, treatment_plan, notes)
    VALUES ($1, $2, $3, $4, $5) RETURNING *;
  `;
  const values = [complaint_id, assessing_professional_id, diagnosis, treatment_plan, notes || null];

  try {
    const result = await db.query(insertQuery, values);
    
    // ★★★ NOVA LÓGICA DE NOTIFICAÇÃO PARA O PILOTO ★★★
    // 1. Buscar os dados da queixa original para saber para qual piloto enviar a notificação.
    const complaintResult = await db.query('SELECT pilot_user_id, location FROM complaints WHERE id = $1', [complaint_id]);
    
    if (complaintResult.rows.length > 0) {
      const pilotUserId = complaintResult.rows[0].pilot_user_id;
      const complaintLocation = complaintResult.rows[0].location;

      // 2. Criar a mensagem e o link da notificação.
      const notificationMessage = `O parecer para sua queixa de ${complaintLocation} está disponível.`;
      const notificationLink = `/my-complaints/${complaint_id}`;

      // 3. Inserir a notificação na tabela para o piloto.
      await db.query(
        'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)',
        [pilotUserId, notificationMessage, notificationLink]
      );
      console.log(`Notificação de parecer criada para o piloto ID: ${pilotUserId}`);
    }
    // ★★★ FIM DA NOVA LÓGICA ★★★

    res.status(201).json({ message: 'Parecer salvo com sucesso!', assessment: result.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar parecer:', error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao salvar o parecer.' });
  }
});