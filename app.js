'use strict';

require('dotenv').config();

const fs = require('fs');

const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const bodyParser = require('body-parser');
const passport = require('passport');
const GitHubStrategy = require('passport-github').Strategy;
const ensureLoggedIn = require('connect-ensure-login').ensureLoggedIn;
const Octokit = require('@octokit/rest');

let authUser = null;
let currentUser = null;
let repoName = null;

let buff = fs.readFileSync('README-Solutions.md');
let readmeContent = buff.toString('base64');

const app = express();

// Creates API connection for private solution repo and gets authUser information.
const authOctokit = new Octokit({
    auth: process.env.GITHUB_OAUTH_TOKEN
});

authOctokit.users.getAuthenticated().then(({data, headers, status}) => {authUser = data;});

async function getUserSolutionRepo(next) {
    return await authOctokit.repos.get({owner: authUser.login, repo: repoName})
        .then(({data}) => {
            return data;
        })
        .catch(error => {
            if (error.status === 404) {
                return null;
            } else {
                next(error);
            }
        });
}

async function checkForCollaborator(next) {
    return await authOctokit.repos.checkCollaborator({
        owner: authUser.login,
        repo: repoName,
        username: currentUser.username
    })
        .then(({data, headers, status}) => {
            return data;
        })
        .catch(error => {
            if (error.status === 404) {
                return null;
            } else {
                next(error);
            }
        })
}

async function addCollaborator(next) {
    return await authOctokit.repos.addCollaborator({
        owner: authUser.login,
        repo: repoName,
        username: currentUser.username
    })
        .then(({data, headers, status}) => {
            console.log('OAuth User added to list of collaborators');
            return data.html_url;
        })
        .catch(error => {
            next(error);
        });
}

async function getInviteLink(next) {
    return await authOctokit.repos.listInvitations({owner: authUser.login, repo: repoName})
        .then(({data, headers, status}) => {
            let userInvite = null;
            data.forEach(invite => {
                if (invite.invitee.login === currentUser.username) {
                    userInvite = invite.html_url;
                }
            });
            return userInvite;
        })
        .catch(error => {
            next(error);
        });
}

async function createUserRepo(next) {
    try {
        await authOctokit.repos.createForAuthenticatedUser({
            name: repoName,
            private: true
        })
            .then(() => {
                console.log('Solution repository created');
            })
            .catch(error => {
                next(error);
            });

        await authOctokit.repos.createFile({
            owner: authUser.login,
            repo: repoName,
            path: 'README.md',
            message: 'Initial Commit - Created readme',
            content: readmeContent
        })
            .then(() => {
                console.log('Readme created.')
            })
            .catch(error => {
                next(error);
            });
    } catch (e) {
        next(e);
    }
}

// Configure the GitHub Strategy for use by Passport
passport.use(new GitHubStrategy({
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: '/login/github/callback'
    },
    function(accessToken, refreshToken, profile, cb) {
        currentUser = profile;
        app.locals.username = currentUser.username;
        repoName = currentUser.username + "-solution";
        return cb(null, profile);
    }));

// Configure Passport authenticated session persistence
passport.serializeUser(function(user, cb) {
    cb(null, user);
});

passport.deserializeUser(function(user, cb) {
    cb(null, user);
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(require('express-session')({ secret: 'keyboard cat', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/views/stylesheets', express.static(__dirname + '/views/stylesheets'));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(cookieParser());

// Initialize Passport and restore authentication state, if any, from the session
app.use(passport.initialize());
app.use(passport.session());

app.get('/',
    ensureLoggedIn(),
    (req, res, next) => {
        app.locals.rendFile = 'challenge-setup';
        getUserSolutionRepo(next).then((data) => {
            if (data !== null) {
                app.locals.repo_url = data.html_url;
                res.redirect('/challenge-1');
            } else {
                res.render('challenge-setup', {error: req.query.error});
            }
        });
    });

app.get('/login', function(req, res, next) {
    try {
        res.render('login', {error: req.query.error});
    } catch(e) {
        next(e);
    }
});

app.get('/challenge-1',
    ensureLoggedIn(),
    (req, res, next) => {
        app.locals.rendFile = 'challenge-1';
        try {
            checkForCollaborator(next).then((data) => {
                if (data === null) {
                    getInviteLink(next).then((data) => {
                        if (data === null) {
                            addCollaborator(next).then((data) => {
                                app.locals.invite_url = data;
                                res.render('challenge-repo-invite', {error: req.query.error});
                            });
                        } else {
                            app.locals.invite_url = data;
                            res.render('challenge-repo-invite', {error: req.query.error});
                        }
                    })
                } else {
                    res.render('challenge-1', {error: req.query.error});
                }
            });
        } catch(e) {
            next(e);
        }
    });

app.get('/create-branch',
    ensureLoggedIn(),
    (req, res, next) => {
        createUserRepo(next).then(() => {
            try {
                res.redirect('/');
            } catch(e) {
                next(e);
            }
        }).catch(e => {next(e)});
    });

app.get('/login/github', passport.authenticate('github'));

app.get('/login/github/callback', passport.authenticate('github', {failureRedirect: '/login'}),
    function(req, res, next) {
        // Successfully authenticated, return home
        try {
            res.redirect('/');
        } catch(e) {
            next(e);
        }
    });

app.get('/logout', function(req, res, next) {
    try {
        req.logout();
        res.redirect('/');
    } catch(e) {
        next(e);
    }
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
