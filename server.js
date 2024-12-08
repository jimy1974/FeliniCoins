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



// Load the pre-generated questions into memory at startup
const questionsFile = 'generated_questions.json';
let questions = [];

try {
    const fileData = fs.readFileSync(questionsFile, 'utf8');
    questions = JSON.parse(fileData);
    console.log(`Loaded ${questions.length} questions from ${questionsFile}`);
} catch (error) {
    console.error(`Error loading questions from ${questionsFile}:`, error);
}

// Game State Management
class FunnyIQGame {
    constructor(state = {}) {
        this.balance = state.balance || 0; // Default balance in FELNY
        this.difficulties = ["easy", "medium", "hard", "very hard"];
        this.currentDifficulty = state.currentDifficulty || 1; // Start at medium difficulty
    }

    // generateQuestion Method (Modified to use pre-generated questions)
    generateQuestion() {
        if (questions.length === 0) {
            console.error("No questions available. Please check the questions file.");
            return {
                question: "Error: No questions available.",
                options: [],
                answer: "N/A",
                explanation: "Please contact support.",
            };
        }

        const randomIndex = Math.floor(Math.random() * questions.length);
        const selectedQuestion = questions[randomIndex];
        const questionText = selectedQuestion.question;

        try {
            // Extract the question
            const questionMatch = questionText.match(/Question:\s*(.+?)(?=\nOptions:)/s);
            const question = questionMatch ? questionMatch[1].trim() : null;

            // Extract the options
            const optionsMatch = questionText.match(/Options:\s*((?:A: .+\n?)+)/s);
            let options = [];
            if (optionsMatch) {
                const optionsText = optionsMatch[1].trim();
                options = optionsText.split('\n').map(line => {
                    const optionMatch = line.match(/^[A-E]:\s*(.+)$/);
                    return optionMatch ? optionMatch[1].trim() : null;
                }).filter(Boolean);
            }

            // Extract the answer
            const answerMatch = questionText.match(/Answer:\s*([A-E])/);
            const answer = answerMatch ? answerMatch[1].trim() : null;

            // Extract the explanation
            const explanationMatch = questionText.match(/Explanation:\s*(.+)/s);
            const explanation = explanationMatch ? explanationMatch[1].trim() : null;

            return {
                question: question || "No question found.",
                options: options.length > 0 ? options : ["No options available."],
                answer: answer || "No answer provided.",
                explanation: explanation || "No explanation available.",
            };
        } catch (error) {
            console.error("Error parsing question:", error);
            return {
                question: "Error parsing question.",
                options: ["N/A"],
                answer: "N/A",
                explanation: "Error encountered while parsing.",
            };
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
            reward: reward,
        };
    }

    getPayoutMultiplier(difficulty) {
        const payoutMultipliers = {
            easy: 100,
            medium: 500,
            hard: 1000,
            very_hard: 2000,
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
let cachedBalance = 0;
let lastBalanceFetchTime = 0;
const BALANCE_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function getTotalSiteBalance() {
    const now = Date.now();
    if (now - lastBalanceFetchTime > BALANCE_FETCH_INTERVAL_MS) {
        const account = await server.loadAccount(distributionKeys.publicKey());
        const balance = account.balances.find(
            (b) => b.asset_code === 'FELNY' && b.asset_issuer === process.env.ISSUER_PUBLIC_KEY
        );
        cachedBalance = balance ? parseFloat(balance.balance) : 0;
        lastBalanceFetchTime = now;
    }
    return cachedBalance;
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


app.get('/about', (req, res) => {
    res.render('about', { user: req.user || null });
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

app.get('/fetch-question', (req, res) => {
    try {
        const game = FunnyIQGame.fromJSON(req.session.gameState || {});

        console.log('Fetching question...');
        const questionData = game.generateQuestion();

        if (!questionData || !questionData.question) {
            console.error('No question data returned.');
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

        console.log('Generated question:', questionData);
        res.json({
            token: questionToken,
            question: questionData.question,
            options: questionData.options,
        });
    } catch (error) {
        console.error('Error fetching question:', error.stack || error);
        res.status(500).json({ error: 'Error fetching question.' });
    }
});


function calculateReward(totalBalance, difficultyMultiplier) {
    const baseReward = Math.floor(totalBalance / 1000000); // Adjust divisor for scaling
    return Math.max(Math.floor(baseReward * difficultyMultiplier), 1); // Ensure minimum reward of 1
}



const answerLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // limit each IP to 5 requests per minute
    message: 'Too many submissions, please try again later.',
});

// Handle answer submission
const MIN_ANSWER_DELAY_MS = 5000; // 5 seconds delay to prevent automated abuse

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
                reward: currentQuestion.reward || 0, // Use the stored reward
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

        // Fetch the total site balance dynamically
        const totalSiteBalance = await getTotalSiteBalance();

        // Difficulty multiplier for reward scaling
        const difficultyMultipliers = {
            easy: 0.5,
            medium: 1.0,
            hard: 1.5,
            very_hard: 2.0,
        };
        const difficultyMultiplier = difficultyMultipliers[currentQuestion.difficulty.toLowerCase().replace(' ', '_')] || 1;

        // Calculate the reward dynamically
        const reward = isCorrect ? calculateReward(totalSiteBalance, difficultyMultiplier) : 0;

        // Store the reward in the session
        req.session.currentQuestion.reward = reward;

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
            reward: reward, // Dynamically calculated reward
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



app.get('/users', async (req, res) => {
    try {
        // Fetch all users from the database
        const users = await FeliniUser.findAll({
            attributes: ['id', 'username', 'email', 'tokens'], // Select specific fields
            order: [['tokens', 'DESC']] // Optional: Order by tokens descending
        });

        // Render the users.ejs file, passing the users data
        res.render('users', { users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).send('Error fetching users.');
    }
});

