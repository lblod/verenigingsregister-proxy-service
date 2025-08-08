import { app } from 'mu';
import verenigingenRouter from './lib/verenigingen.js';

app.use(express.json());

// Routes
app.use('/verenigingen', verenigingenRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.response?.status || 500).json({
    error: err.message,
    details: err.response?.data,
  });
});
