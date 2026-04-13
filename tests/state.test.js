import React, { useState } from 'react';

const IncidentForm = ({ onSubmit }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('low');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ title, description, priority });
    setTitle('');
    setDescription('');
    setPriority('low');
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Incident Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <textarea
        placeholder="Incident Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
      />
      <select value={priority} onChange={(e) => setPriority(e.target.value)}>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <button type="submit">Submit Incident</button>
    </form>
  );
};

export default IncidentForm;