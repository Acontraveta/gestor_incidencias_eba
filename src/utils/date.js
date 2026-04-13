const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const app = express();
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/ims', { useNewUrlParser: true, useUnifiedTopology: true });

// Incident Schema
const incidentSchema = new mongoose.Schema({
  title: String,
  description: String,
  severity: String,
  status: String,
  createdAt: { type: Date, default: Date.now },
});

const Incident = mongoose.model('Incident', incidentSchema);

// API to create a new incident
app.post('/api/incidents', async (req, res) => {
  const incident = new Incident(req.body);
  await incident.save();
  res.status(201).send(incident);
});

// API to get all incidents
app.get('/api/incidents', async (req, res) => {
  const incidents = await Incident.find();
  res.send(incidents);
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});