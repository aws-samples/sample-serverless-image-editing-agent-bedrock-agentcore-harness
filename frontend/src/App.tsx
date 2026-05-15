import { Authenticator } from '@aws-amplify/ui-react';
import { EditorPage } from './pages/EditorPage';
import { Header } from './components/Header';

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <div className="h-screen w-screen overflow-hidden bg-gray-950 flex flex-col">
          <Header
            email={user?.signInDetails?.loginId || ''}
            onSignOut={signOut || (() => {})}
          />
          <EditorPage />
        </div>
      )}
    </Authenticator>
  );
}

export default App;
