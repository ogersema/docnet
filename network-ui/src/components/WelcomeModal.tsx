import React from 'react';
import { uiConfig } from '../config';

interface WelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WelcomeModal({ isOpen, onClose }: WelcomeModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-gray-700">
        <div className="p-6">
          <h2 className="text-2xl font-bold mb-4 text-white">
            {uiConfig.welcomeTitle}
          </h2>

          <div className="space-y-4 text-gray-300">
            <p className="whitespace-pre-line">{uiConfig.welcomeBody}</p>
            {uiConfig.aiAttributionNote && (
              <p className="text-sm text-gray-400 italic mt-2">{uiConfig.aiAttributionNote}</p>
            )}

            <div className="bg-gray-900 border border-gray-600 rounded-lg p-4 mt-6">
              <h3 className="font-semibold text-blue-400 mb-2">How to use:</h3>
              <ul className="list-disc list-inside space-y-1 text-gray-300">
                {uiConfig.howToUse.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700
                       transition-colors font-medium"
            >
              Get Started
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
