require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const StellarSdk = require('@stellar/stellar-sdk');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const app = express();

// Import database and models
const sequelize = require('./db');
const FeliniUser = require('./models/FeliniUser');

// Set the base URL and redirect URI from .env variables
const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:5000';
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `${appBaseUrl}/auth/google/callback`;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public')); // Serve static files


// Session setup
app.use(session({
    secret: crypto.randomBytes(64).toString('hex'), // Use a secure secret key
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

// Sync the database
sequelize.sync()
  .then(() => {
    console.log('Database synchronized successfully.');
    // Start the server
    app.listen(5000, () => console.log('Server running on port 5000'));
  })
  .catch(err => {
    console.error('Error synchronizing database:', err);
  });


// OpenAI Configuration
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// Initialize Stellar
const server = new StellarSdk.Horizon.Server('https://horizon.stellar.org');
const distributionSecret = process.env.DISTRIBUTION_SECRET_KEY; // Replace with your secret key
const distributionKeys = StellarSdk.Keypair.fromSecret(distributionSecret);
const FELNY = new StellarSdk.Asset('FELNY', process.env.ISSUER_PUBLIC_KEY ); // Replace with your issuer public key


// Load the files at startup
const adjectives = fs.readFileSync('adjectives.txt', 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
const subjects = fs.readFileSync('subjects.txt', 'utf8').split('\n').map(line => line.trim()).filter(Boolean);

// Function to get random combinations of adjectives and subjects
function getRandomAdjectiveSubjectPair() {
    const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    //const randomSubject = subjects[Math.floor(Math.random() * subjects.length)];
    const randomAdjective2 = adjectives[Math.floor(Math.random() * adjectives.length)];
    
    return `${randomAdjective} ${randomAdjective2}`;
}

// Game State Management
class FunnyIQGame {
    constructor(state = {}) {
        this.balance = state.balance || 0; // Default balance in FELNY
        this.difficulties = ["easy", "medium", "hard", "very hard"];
        this.currentDifficulty = state.currentDifficulty || 1; // Start at medium difficulty
    }

    // generateQuestion Method
    async generateQuestion(difficultyLevel = this.currentDifficulty) {
        const difficultyName = this.difficulties[difficultyLevel];

        try {
            // Generate three random adjective-subject pairs
            const randomPairs = Array.from({ length: 3 }, () => getRandomAdjectiveSubjectPair()).join(', ');

            console.log(randomPairs);

            const response = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: "You are a question generator. Each question must be unique and thought-provoking."
                    },
                    {
                        role: "user",
                        content: `Please create a very funny and creative multi-choice question, taking some inspiration from the following words: ${randomPairs}.                      
                      - Include 5 unique options (A, B, C, D, E).
                      - Keep the explanation brief (1-2 sentences).
                      Format the response as:

Question: [Your Question]

Options:
A: [Option A]
B: [Option B]
C: [Option C]
D: [Option D]
E: [Option E]

Answer: [Correct Option only include the LETTER]

Explanation: [One to two sentences explaining why the answer is correct, but don't ruin the joke or humour by saying why it's funny, logical or creative.]`
                    }
                ],
                max_tokens: 300,
                temperature: 0.9
            });

            const content = response.choices[0].message.content;

            // Extract question, options, and explanation
            const questionMatch = content.match(/Question:\s*(.+?)(?=\nOptions:)/s);
            const optionsMatch = content.match(/Options:\s*((?:A: .+\n?)+)/s);
            const answerMatch = content.match(/Answer:\s*(.+?)(?=\nExplanation:)/s);
            const explanationMatch = content.match(/Explanation:\s*(.+)/s);

            let options = [];
            if (optionsMatch) {
                const optionsText = optionsMatch[1].trim();
                const lines = optionsText.split('\n');
                lines.forEach(line => {
                    const optionMatch = line.match(/^[A-E]:\s*(.+)$/);
                    if (optionMatch) {
                        options.push(optionMatch[1].trim());
                    }
                });
            }

            return {
                question: questionMatch ? questionMatch[1].trim() : "No question provided.",
                options,
                answer: answerMatch ? answerMatch[1].trim().toUpperCase() : "No answer provided.",
                explanation: explanationMatch ? explanationMatch[1].trim() : "No explanation provided."
            };
        } catch (error) {
            console.error("Question generation error:", error);
            return null;
        }
    }

    processAnswer(isCorrect, difficulty) {
        let reward = 0;

        if (isCorrect) {
            reward = this.getPayoutMultiplier(difficulty);
            this.balance += reward;
        }

        return {
            balance: this.balance,
            difficulty: this.difficulties[this.currentDifficulty],
            reward: reward
        };
    }

    getPayoutMultiplier(difficulty) {
        const payoutMultipliers = {
            'easy': 100,
            'medium': 500,
            'hard': 1000,
            'very_hard': 2000
        };
        return payoutMultipliers[difficulty] || 100;
    }

    toJSON() {
        return {
            balance: this.balance,
            currentDifficulty: this.currentDifficulty,
        };
    }

    static fromJSON(state) {
        return new FunnyIQGame(state);
    }
}





//// GOOGLE LOGIN

passport.serializeUser((user, done) => {
    done(null, user.id); // Store user ID in the session
});


passport.deserializeUser(async (id, done) => {
    try {
        const user = await FeliniUser.findByPk(id);
        if (user) {
            done(null, user); // Attach user object to `req.user`
        } else {
            done(new Error('User not found'), null);
        }
    } catch (err) {
        done(err, null);
    }
});



const GoogleStrategy = require('passport-google-oauth20').Strategy;

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: googleRedirectUri
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // Check if user exists
    let user = await FeliniUser.findOne({ where: { googleId: profile.id } });

    if (!user) {
      // Check for an existing email
      const emailUser = await FeliniUser.findOne({ where: { email: profile.emails[0].value } });

      if (emailUser) {
        // Link Google ID to existing user
        emailUser.googleId = profile.id;
        await emailUser.save();
        user = emailUser;
      } else {
        // Create a new user
        user = await FeliniUser.create({
          username: profile.displayName || `User${Date.now()}`,
          email: profile.emails[0].value,
          googleId: profile.id,
          photo: profile.photos[0] ? profile.photos[0].value : null
        });
      }
    }

    return done(null, user);
  } catch (error) {
    console.error('Error in Google Strategy:', error);
    return done(error, null);
  }
}));



app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  async (req, res) => {
    try {
      const user = req.user;

      // Fetch balance from the database
      const dbUser = await FeliniUser.findByPk(user.id);
      if (dbUser) {
        // Initialize game state with balance from the database
        const newGame = new FunnyIQGame({ balance: dbUser.tokens });
        req.session.gameState = newGame.toJSON();
      }

      res.redirect('/start');
    } catch (error) {
      console.error('Error setting up session after login:', error);
      res.redirect('/login');
    }
  }
);




/////////////////////////




// Helper functions
async function getTotalSiteBalance() {
    // Fetch the current total FELNY balance for the distribution account
    const account = await server.loadAccount(distributionKeys.publicKey());
    const balance = account.balances.find(
        (b) => b.asset_code === 'FELNY' && b.asset_issuer === process.env.ISSUER_PUBLIC_KEY
    );
    return balance ? parseFloat(balance.balance) : 0;
}

async function awardTokens(destinationWallet, amount) {
    // Send tokens from the distribution account to the specified wallet
    try {
        const account = await server.loadAccount(distributionKeys.publicKey());
        const transaction = new StellarSdk.TransactionBuilder(account, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: StellarSdk.Networks.PUBLIC,
        })
            .addOperation(
                StellarSdk.Operation.payment({
                    destination: destinationWallet,
                    asset: FELNY,
                    amount: amount.toString(),
                })
            )
            .setTimeout(30)
            .build();

        transaction.sign(distributionKeys);
        await server.submitTransaction(transaction);
    } catch (error) {
        console.error('Error transferring tokens:', error.response ? error.response.data : error);
        throw error;
    }
}

// Backup Functionality (Basic Implementation)
const backupInterval = 60 * 60 * 1000; // Every hour

function performBackup() {
    // Since we are using session storage, we cannot access all user sessions directly
    // For demonstration, we'll log a message
    // Implementing a proper backup would require a persistent session store
    console.log('Backup performed at', new Date().toISOString());

    // Example: Backup the current session's game state
    // This requires access to a specific request, which isn't feasible in this context
    // So we'll skip actual backup
}

setInterval(performBackup, backupInterval);

// Routes

// Index page
app.get('/', async (req, res) => {
    try {
        if (req.isAuthenticated()) {
            // Redirect logged-in users directly to /start
            return res.redirect('/start');
        }

        if (!req.session.gameState) {
            const newGame = new FunnyIQGame();
            req.session.gameState = newGame.toJSON();
        }

        const game = FunnyIQGame.fromJSON(req.session.gameState);
        const totalSiteBalance = await getTotalSiteBalance();

        res.render('index', {
            balance: game.balance,
            totalSiteBalance: totalSiteBalance.toFixed(2),
            user: req.user || null, // Pass the user object if available, otherwise null
        });
    } catch (error) {
        console.error('Error loading index:', error);
        res.status(500).send('Error loading the page.');
    }
});



app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error('Error during logout:', err);
            return res.redirect('/'); // Redirect to home in case of error
        }
        req.session.destroy(() => {
            res.redirect('/'); // Redirect to home after logout
        });
    });
});


app.get('/start', async (req, res) => {
    try {
        if (!req.session.gameState) {
            console.log('req.user:', req.user);

            const dbUser = await FeliniUser.findByPk(req.user.id);
            const initialBalance = dbUser ? dbUser.tokens : 0;

            const newGame = new FunnyIQGame({ balance: initialBalance });
            req.session.gameState = newGame.toJSON();
        }

        const game = FunnyIQGame.fromJSON(req.session.gameState);

        res.render('game', {
            balance: game.balance,
            difficulty: game.difficulties[game.currentDifficulty],
            user: req.user || null,
        });
    } catch (error) {
        console.error('Error loading game:', error);
        res.status(500).send('Error loading the game.');
    }
});

// New endpoint to fetch question asynchronously
app.get('/fetch-question', async (req, res) => {
    try {
        const game = FunnyIQGame.fromJSON(req.session.gameState);
        const questionData = await game.generateQuestion(game.currentDifficulty);

        if (!questionData) {
            return res.status(500).send('Error generating question.');
        }

        const questionToken = crypto.randomBytes(16).toString('hex');

        req.session.currentQuestion = {
            token: questionToken,
            question: questionData.question,
            options: questionData.options,
            answer: questionData.answer,
            explanation: questionData.explanation,
            difficulty: game.difficulties[game.currentDifficulty],
            timestamp: Date.now(),
            answered: false,
        };

        res.json({
            token: questionToken,
            question: questionData.question,
            options: questionData.options,
        });
    } catch (error) {
        console.error('Error fetching question:', error);
        res.status(500).json({ error: 'Error fetching question.' });
    }
});




const answerLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // limit each IP to 5 requests per minute
    message: 'Too many submissions, please try again later.',
});

// Handle answer submission
const MIN_ANSWER_DELAY_MS = 5000; // 5 seconds delay to prevent automated abuse

//app.post('/answer', async (req, res) => {
app.post('/answer', async (req, res) => {
    try {
        if (!req.session.gameState || !req.session.currentQuestion) {
            return res.status(400).send('No active game found.');
        }

        const { token, answer } = req.body;
        const currentQuestion = req.session.currentQuestion;

        // Ensure token matches the current question
        if (!currentQuestion.token || currentQuestion.token !== token) {
            return res.status(400).send('Invalid question token.');
        }

        const game = FunnyIQGame.fromJSON(req.session.gameState);

        // If the question has already been answered, render the result page again
        if (currentQuestion.answered) {
            return res.render('result', {
                isCorrect: currentQuestion.isCorrect,
                reward: currentQuestion.isCorrect ? game.getPayoutMultiplier(currentQuestion.difficulty.toLowerCase().replace(' ', '_')) : 0,
                explanation: currentQuestion.explanation,
                balance: game.balance,
                user: req.user || null,
            });
        }

        // Enforce a delay between serving the question and accepting an answer
        const timeSinceQuestion = Date.now() - currentQuestion.timestamp;
        const MIN_ANSWER_DELAY_MS = 5000; // 5 seconds
        if (timeSinceQuestion < MIN_ANSWER_DELAY_MS) {
            return res.status(400).send('Please wait before submitting your answer.');
        }

        const correctAnswer = currentQuestion.answer.trim().charAt(0).toUpperCase();
        const isCorrect = answer.trim().charAt(0).toUpperCase() === correctAnswer;

        const gameState = game.processAnswer(isCorrect, currentQuestion.difficulty.toLowerCase().replace(' ', '_'));

        const userId = req.user ? req.user.id : req.session.passport?.user;

        if (!userId) {
            throw new Error('User ID not found in session');
        }

        // Update the database with the new balance only if the answer is correct
        if (isCorrect) {
            await FeliniUser.update(
                { tokens: gameState.balance },
                { where: { id: userId } }
            );
        }

        // Mark the question as answered and store the result in the session
        req.session.currentQuestion.answered = true;
        req.session.currentQuestion.isCorrect = isCorrect;
        req.session.gameState = game.toJSON();

        res.render('result', {
            isCorrect,
            reward: isCorrect ? gameState.reward : 0,
            explanation: currentQuestion.explanation,
            balance: gameState.balance,
            user: req.user || null,
        });
    } catch (error) {
        console.error('Error processing answer:', error);
        res.status(500).send('Error processing your answer.');
    }
});



app.use(async (req, res, next) => {
    if (req.user) {
        try {
            const dbUser = await FeliniUser.findByPk(req.user.id);
            if (dbUser && req.session.gameState) {
                const game = FunnyIQGame.fromJSON(req.session.gameState);
                if (game.balance !== dbUser.tokens) {
                    game.balance = dbUser.tokens;
                    req.session.gameState = game.toJSON();
                }
            }
        } catch (error) {
            console.error('Error syncing balance:', error);
        }
    }
    next();
});



app.get('/withdraw', async (req, res) => {
    const game = FunnyIQGame.fromJSON(req.session.gameState); // Deserialize session state

    console.log( game.balance );
    
    // Retrieve the sender's default address (optional)
    const defaultAddress = req.session.senderAddress;

    res.render('withdraw', {
        //totalWinnings: game.balance.toFixed(2), // Format winnings for display
        balance: game.balance.toFixed(2), // Format winnings for display
        defaultAddress, // Default address to prefill the form if available
        user: req.user || null, // Pass user to the template
    });
});


async function submitTransactionWithRetry(transaction, maxRetries = 3) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const response = await server.submitTransaction(transaction);
            return response; // Transaction submitted successfully
        } catch (error) {
            attempts++;
            if (attempts >= maxRetries) {
                throw error; // Rethrow the error after max retries
            }
            console.log(`Retrying transaction submission (${attempts}/${maxRetries})...`);
        }
    }
}




app.post('/process-withdrawal', async (req, res) => {
    const { walletAddress } = req.body;
    const game = FunnyIQGame.fromJSON(req.session.gameState);

    if (game.balance <= 0) {
        return res.render('withdrawal-failure', {
            message: 'You have no tokens to withdraw.',
        });
    }

    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
        return res.render('withdrawal-failure', {
            message: 'Invalid Stellar wallet address. Please check and try again.',
        });
    }

    try {
        const recipientAccount = await server.loadAccount(walletAddress);
        const hasTrustline = recipientAccount.balances.some(
            (balance) => balance.asset_code === 'FELNY' && balance.asset_issuer === process.env.ISSUER_PUBLIC_KEY
        );

        if (!hasTrustline) {
            return res.render('withdrawal-failure', {
                message: 'Recipient wallet does not have a trustline for FELNY tokens.',
            });
        }

        const distributionAccount = await server.loadAccount(distributionKeys.publicKey());
        const transaction = new StellarSdk.TransactionBuilder(distributionAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: StellarSdk.Networks.PUBLIC,
        })
            .addOperation(
                StellarSdk.Operation.payment({
                    destination: walletAddress,
                    asset: FELNY,
                    amount: game.balance.toFixed(7),
                })
            )
            .setTimeout(120)
            .build();

        transaction.sign(distributionKeys);

        const transactionAmount = game.balance.toFixed(7); // Track the actual amount
        const result = await submitTransactionWithRetry(transaction, 3);

        console.log('Withdrawal successful:', result);

        // Update session and database
        game.balance = 0;
        req.session.gameState = game.toJSON();

        const userId = req.user ? req.user.id : req.session.passport?.user; // Fetch the user ID

        if (userId) {
            await FeliniUser.update(
                { tokens: 0 }, // Reset the tokens in the database
                { where: { id: userId } }
            );
        } else {
            console.error('User ID not found in session.');
        }

        return res.render('withdrawal-success', {
            walletAddress,
            amount: transactionAmount, // Use the correct transaction amount
        });
    } catch (error) {
        console.error('Error processing withdrawal:', error);

        return res.render('withdrawal-failure', {
            message: 'An error occurred while processing your withdrawal. Please try again later.',
        });
    }
});

